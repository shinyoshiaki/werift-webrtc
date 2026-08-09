import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../../common/src";
import { DtlsVersion } from "../../../src";
import { DirectHandshakeCarrier } from "../../../src/carrier/direct";
import type { RetransmissionMode } from "../../../src/carrier/types";
import {
  createDtlsClientInternal,
  createDtlsServerInternal,
} from "../../../src/internal";
import { certPem, keyPem } from "../../fixture";

/**
 * Association-level carrier injection + external retransmission mode.
 * Carrier unit tests alone are insufficient — exercise a real DTLS 1.3 HS.
 */
describe("association external carrier / retransmission mode", () => {
  test("injected DirectHandshakeCarrier completes handshake", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const serverCarrier = new DirectHandshakeCarrier(serverTransport, {
      mtu: 1200,
    });
    const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
      mtu: 1200,
    });

    // handshakeCarrier は非公開ファクトリ経由のみ（安定 Public API ではない）
    const server = createDtlsServerInternal({
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: serverCarrier,
    });
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: clientCarrier,
    });

    // Act / Assert: ハンドシェイクを検証する
    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("injected carrier handshake timeout")),
        15_000,
      );
      client.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.onError.subscribe((e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.onConnect.subscribe(() => {
        // Assert: ハンドシェイクを検証する
        const eng = (client as any).engine13;
        expect(eng.carrier).toBe(clientCarrier);
        expect(clientCarrier.getRetransmissionMode()).toBe("internal");
        clearTimeout(timer);
        client.close();
        server.close();
        resolve();
      });
      await client.connect();
    });
  }, 20_000);

  test("external mode stops association retransmit; internal resumes", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const clientCarrier = new DirectHandshakeCarrier(clientTransport, {
      mtu: 1200,
    });
    let clientTx = 0;
    const origSend = clientCarrier.send.bind(clientCarrier);
    clientCarrier.send = async (pkt, addr) => {
      clientTx++;
      return origSend(pkt, addr);
    };

    // Blackhole: server does not process (never responds)
    // Use a dummy server transport peer so CH is sent
    const client = createDtlsClientInternal({
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      protocolVersions: [DtlsVersion.V1_3],
      addressValidation: "none",
      handshakeCarrier: clientCarrier,
    });
    // No server — client will retransmit ClientHello

    const modes: RetransmissionMode[] = [];
    const eng = (client as any).engine13;
    const prevHook = clientCarrier.events.onRetransmissionModeChange;
    clientCarrier.events.onRetransmissionModeChange = (m) => {
      modes.push(m);
      prevHook?.(m);
    };

    // Act: carrier/再送を検証する
    void client.connect();
    await new Promise((r) => setTimeout(r, 80));
    const txBeforeExternal = clientTx;
    expect(txBeforeExternal).toBeGreaterThanOrEqual(1);
    expect(eng.getPendingFlightSize()).toBeGreaterThan(0);

    // Switch to external: association cancel retransmit + carrier stops timers
    clientCarrier.setRetransmissionMode("external");
    await new Promise((r) => setTimeout(r, 1200));
    const txDuringExternal = clientTx;
    // Assert: carrier/再送を検証する
    expect(txDuringExternal).toBe(txBeforeExternal);
    expect(modes).toContain("external");

    // Resume internal: association scheduleRetransmit runs again
    clientCarrier.setRetransmissionMode("internal");
    await new Promise((r) => setTimeout(r, 1500));
    // Assert: carrier/再送を検証する
    expect(clientTx).toBeGreaterThan(txDuringExternal);
    expect(modes).toEqual(["external", "internal"]);

    client.close();
    await clientTransport.close();
    await serverTransport.close();
  }, 15_000);
});
