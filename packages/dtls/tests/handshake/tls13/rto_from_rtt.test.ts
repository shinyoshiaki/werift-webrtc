import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { DtlsVersion } from "../../../src";
import { DirectHandshakeCarrier } from "../../../src/carrier/direct";
import {
  MAX_RTO_MS,
  MIN_RTO_MS,
  RTO_FACTOR,
} from "../../../src/engine/v1_3/types";
import { createDtlsClientInternal } from "../../../src/internal";
import { certPem, keyPem } from "../../fixture";

/**
 * Deterministic association RTO = f(carrier RTT, retransmitCount).
 * No sleep-based E2E — intercept carrier.schedule delays.
 */
describe("association RTO uses carrier RTT", () => {
  test("updateRtt changes next schedule delay (not fixed 1s)", async () => {
    // Arrange: blackhole peer — ClientHello stays pending and schedules RTO
    const clientTransport = await UdpTransport.init("udp4");
    // Dummy remote so connect() pins a destination
    clientTransport.rinfo = { address: "203.0.113.50", port: 4444 } as any;

    const carrier = new DirectHandshakeCarrier(clientTransport, { mtu: 1200 });
    const scheduledMs: number[] = [];
    const origSchedule = carrier.schedule.bind(carrier);
    carrier.schedule = (ms: number, fn: () => void) => {
      scheduledMs.push(ms);
      // Do not fire timers — we only assert schedule arguments
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

    // Act: low RTT → short RTO
    carrier.updateRtt(50);
    expect(carrier.getRtt()).toBe(50);
    void client.connect();
    await new Promise((r) => setTimeout(r, 30));

    const expectedLow = Math.min(
      MAX_RTO_MS,
      Math.max(MIN_RTO_MS, Math.round(50 * RTO_FACTOR)),
    );
    expect(scheduledMs.length).toBeGreaterThanOrEqual(1);
    expect(scheduledMs[0]).toBe(expectedLow);

    // Change RTT and force a new schedule via retransmit path
    // (scheduleRetransmit is called after each sendHandshakeFlight)
    const eng = (client as any).engine13;
    scheduledMs.length = 0;
    carrier.updateRtt(500);
    expect(carrier.getRtt()).toBe(500);
    // Manually re-schedule as association would after a flight send
    eng.scheduleRetransmit();
    const expectedHigh = Math.min(
      MAX_RTO_MS,
      Math.max(MIN_RTO_MS, Math.round(500 * RTO_FACTOR)),
    );
    expect(scheduledMs[scheduledMs.length - 1]).toBe(expectedHigh);
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

    client.close();
    await clientTransport.close();
  });
});
