import { setTimeout } from "timers/promises";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { certPem, keyPem } from "../fixture";

const dtls13Options = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  addressValidation: "none" as const,
};

test("e2e/self13 RX 世代不一致の datagram は queue 実行時に破棄される", async () => {
  // Arrange: 1.3-only の client/server を用意し、client 初回 flight を採取する。
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = { address: "127.0.0.1", port: 9 };
  const server = new DtlsServer({
    transport: serverTransport,
    ...dtls13Options,
  });
  const client = new DtlsClient({
    transport: clientTransport,
    ...dtls13Options,
  });
  const capturedFlights: Buffer[] = [];
  const originalClientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (async (data: Buffer, addr?: [string, number]) => {
    capturedFlights.push(Buffer.from(data));
    return originalClientSend(data, addr);
  }) as typeof clientTransport.send;
  const sentByServer: Buffer[] = [];
  serverTransport.send = (async (data: Buffer) => {
    sentByServer.push(Buffer.from(data));
  }) as typeof serverTransport.send;
  // restart 後世代を 7 として provider を固定する。
  server.setExpectedRxGeneration(() => 7);
  const engine = (server as unknown as { engine13: unknown }).engine13;
  if (!engine) throw new Error("1.3 engine が無い");

  try {
    // Act: client の初回 flight が出るまで待つ。
    void client.connect().catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while (capturedFlights.length === 0) {
      if (Date.now() > deadline) throw new Error("client flight が採れない");
      await setTimeout(20);
    }
    const flight = capturedFlights[0]!;
    const peer = clientTransport.address as unknown as [string, number];

    // Act: 旧世代 (6) の受付は queue 実行時に破棄される。
    await (
      engine as {
        handleDatagram(
          data: Buffer,
          addr?: [string, number],
          rxGeneration?: number,
        ): Promise<void>;
      }
    ).handleDatagram(flight, peer, 6);
    await setTimeout(50);

    // Assert: server は一切応答せず、handshake は開始前相のまま。
    expect(sentByServer).toHaveLength(0);
    expect(
      (engine as { hsPhase?: string }).hsPhase,
    ).toBe("wait_client_hello");

    // Act: 現世代 (7) の同一 flight は正常に処理される。
    await (
      engine as {
        handleDatagram(
          data: Buffer,
          addr?: [string, number],
          rxGeneration?: number,
        ): Promise<void>;
      }
    ).handleDatagram(flight, peer, 7);
    await setTimeout(200);

    // Assert: server が ServerHello flight を返す。
    expect(sentByServer.length).toBeGreaterThan(0);
  } finally {
    server.setExpectedRxGeneration(undefined);
    await Promise.allSettled([client.close(), server.close()]);
  }
}, 20_000);
