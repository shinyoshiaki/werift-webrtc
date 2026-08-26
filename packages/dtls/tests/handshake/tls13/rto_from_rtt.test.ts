import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { DtlsVersion } from "../../../src";
import { DirectHandshakeCarrier } from "../../../src/carrier/direct";
import {
  DTLS_SRTP_INITIAL_RTO_MS,
  INITIAL_RTO_MS,
  MAX_RTO_MS,
  MIN_RTO_MS,
  RTO_FACTOR,
} from "../../../src/engine/v1_3/types";
import { createDtlsClientInternal } from "../../../src/internal";
import { certPem, keyPem } from "../../fixture";

/**
 * Deterministic association RTO = f(carrier RTT, retransmitCount).
 * No sleep-based E2E — intercept carrier.schedule delays.
 * RFC 9147 §5.8.2: unknown RTT → initial; known RTT → 1.5 × RTT.
 */
describe("association RTO uses carrier RTT (RFC 9147 §5.8.2)", () => {
  test("RTT unknown uses INITIAL_RTO_MS (not a fabricated sample)", async () => {
    // Arrange: blackhole peer — ClientHello stays pending and schedules RTO
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "203.0.113.50", port: 4444 } as any;

    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const scheduledMs: number[] = [];
    const origSchedule = carrier.schedule.bind(carrier);
    carrier.schedule = (ms: number, fn: () => void) => {
      scheduledMs.push(ms);
      return origSchedule(ms, () => {
        /* swallow */
      });
    };

    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier,
    });

    // Act: no updateRtt — RTT unknown
    expect(carrier.getRtt()).toBe(0);
    expect(carrier.hasRttSample()).toBe(false);
    void client.connect();
    await new Promise((r) => setTimeout(r, 30));

    // Assert: RFC initial 1000ms (not 400 from a fake 100ms sample)
    expect(scheduledMs.length).toBeGreaterThanOrEqual(1);
    expect(scheduledMs[0]).toBe(INITIAL_RTO_MS);

    client.close();
    await clientTransport.close();
  });

  test("updateRtt → 1.5 × RTT base with exponential backoff", async () => {
    // Arrange
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "203.0.113.50", port: 4444 } as any;

    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const scheduledMs: number[] = [];
    const origSchedule = carrier.schedule.bind(carrier);
    carrier.schedule = (ms: number, fn: () => void) => {
      scheduledMs.push(ms);
      return origSchedule(ms, () => {
        /* swallow */
      });
    };

    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier,
    });

    // Act: known RTT 50ms → base 75ms → clamp to MIN_RTO
    carrier.updateRtt(50);
    expect(carrier.getRtt()).toBe(50);
    expect(carrier.hasRttSample()).toBe(true);
    void client.connect();
    await new Promise((r) => setTimeout(r, 30));

    const expectedLow = Math.min(
      MAX_RTO_MS,
      Math.max(MIN_RTO_MS, Math.round(50 * RTO_FACTOR)),
    );
    expect(scheduledMs.length).toBeGreaterThanOrEqual(1);
    expect(scheduledMs[0]).toBe(expectedLow);
    expect(expectedLow).toBe(MIN_RTO_MS); // 75 → 100 clamp

    // RTT=500 → RFC 750ms (was 2000 with factor 4)
    const eng = (client as any).engine13;
    scheduledMs.length = 0;
    carrier.updateRtt(500);
    eng.scheduleRetransmit();
    const expectedHigh = Math.min(
      MAX_RTO_MS,
      Math.max(MIN_RTO_MS, Math.round(500 * RTO_FACTOR)),
    );
    expect(scheduledMs[scheduledMs.length - 1]).toBe(expectedHigh);
    expect(expectedHigh).toBe(750);
    expect(expectedHigh).toBeGreaterThan(expectedLow);

    // Exponential backoff with retransmitCount
    scheduledMs.length = 0;
    eng.retransmitCount = 2;
    eng.scheduleRetransmit();
    const expectedBackoff = Math.min(
      MAX_RTO_MS,
      Math.round(expectedHigh * 2 ** 2),
    );
    expect(scheduledMs[scheduledMs.length - 1]).toBe(expectedBackoff);
    expect(expectedBackoff).toBe(3000);

    client.close();
    await clientTransport.close();
  });

  test("stale RTO after flightId bump does not retransmit", async () => {
    // Arrange: capture the first RTO callback; blackhole so CH stays pending
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "203.0.113.50", port: 4444 } as any;
    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    let pendingFn: (() => void) | undefined;
    const origSchedule = carrier.schedule.bind(carrier);
    carrier.schedule = (ms: number, fn: () => void) => {
      pendingFn = fn;
      return origSchedule(ms, () => {
        /* swallow wall-clock */
      });
    };

    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier,
    });
    void client.connect();
    await new Promise((r) => setTimeout(r, 30));

    const eng = (client as any).engine13;
    expect(eng).toBeTruthy();
    expect(typeof pendingFn).toBe("function");
    const gen = eng.flightId as number;
    expect(gen).toBeGreaterThan(0);

    const sends: number[] = [];
    const origSend = carrier.send.bind(carrier);
    carrier.send = async (...args: Parameters<typeof origSend>) => {
      sends.push(1);
      return origSend(...args);
    };

    // Act: newer flight (sendHandshakeFlight increments flightId) then fire stale RTO
    eng.flightId = gen + 1;
    pendingFn!();
    await new Promise((r) => setTimeout(r, 20));

    // Assert: stale generation must not retransmit the previous flight
    expect(sends.length).toBe(0);

    client.close();
    await clientTransport.close();
  });

  test("DTLS-SRTP profile uses 400ms initial when RTT unknown", async () => {
    // Arrange: srtpProfiles set → DTLS-SRTP initial RTO
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "198.51.100.1", port: 1 } as any;
    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier,
      srtpProfiles: [0x0001], // profile presence only; negotiation not required for RTO
    });
    const eng = (client as any).engine13;

    // Act / Assert: RTT unknown + SRTP → 400ms
    eng.retransmitCount = 0;
    expect(eng.computeRetransmitRtoMs()).toBe(DTLS_SRTP_INITIAL_RTO_MS);

    client.close();
    await clientTransport.close();
  });

  test("computeRetransmitRtoMs clamps to MIN/MAX", async () => {
    // Arrange
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = { address: "198.51.100.1", port: 1 } as any;
    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier,
    });
    const eng = (client as any).engine13;

    // Act / Assert: tiny RTT → MIN_RTO
    carrier.updateRtt(1);
    eng.retransmitCount = 0;
    expect(eng.computeRetransmitRtoMs()).toBe(MIN_RTO_MS);

    // Huge RTT → MAX_RTO
    carrier.updateRtt(60_000);
    expect(eng.computeRetransmitRtoMs()).toBe(MAX_RTO_MS);

    // High backoff also clamps
    carrier.updateRtt(500);
    eng.retransmitCount = 20;
    expect(eng.computeRetransmitRtoMs()).toBe(MAX_RTO_MS);

    // Unknown RTT → INITIAL
    const carrier2 = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const client2 = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: carrier2,
    });
    const eng2 = (client2 as any).engine13;
    expect(eng2.computeRetransmitRtoMs()).toBe(INITIAL_RTO_MS);

    client.close();
    client2.close();
    await clientTransport.close();
  });

  test("resetRtt は sample を落とし、新しい RTT を受け付ける", () => {
    // Arrange
    const carrier = new DirectHandshakeCarrier({
      send: async () => {},
    } as any);
    carrier.updateRtt(50);
    expect(carrier.hasRttSample()).toBe(true);
    expect(carrier.getRtt()).toBe(50);

    // Act: ICE restart 相当
    carrier.resetRtt();

    // Assert: 旧 path の 50ms は使わず、新 sample で再設定できる
    expect(carrier.hasRttSample()).toBe(false);
    expect(carrier.getRtt()).toBe(0);
    carrier.updateRtt(80);
    expect(carrier.hasRttSample()).toBe(true);
    expect(carrier.getRtt()).toBe(80);
  });
});
