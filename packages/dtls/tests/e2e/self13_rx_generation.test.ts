import { setTimeout } from "timers/promises";

import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { ContentType } from "../../src/record/const";
import { encryptRecord } from "../../src/record/v1_3/record";
import { certPem, keyPem } from "../fixture";

const dtls13Options = {
  cert: certPem,
  key: keyPem,
  protocolVersions: [DtlsVersion.V1_3] as const,
  addressValidation: "none" as const,
};

test.each(["transport.onData", "carrier.inject"] as const)(
  "e2e/self13 %s の RX 世代不一致 datagram は queue 実行時に破棄される",
  async (inboundPath) => {
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
    const engine = (
      server as unknown as {
        engine13?: {
          hsPhase?: string;
          getHandshakeCarrier(): {
            inject(
              data: Buffer,
              peer?: [string, number],
              opts?: { rxGeneration?: number },
            ): Promise<void>;
          };
        };
      }
    ).engine13;
    if (!engine) throw new Error("1.3 engine が無い");
    const deliver = async (
      data: Buffer,
      peer: [string, number],
      rxGeneration: number,
    ) => {
      if (inboundPath === "transport.onData") {
        const onData = serverTransport.onData as (
          data: Buffer,
          addr: [string, number],
          meta?: { rxGeneration?: number },
        ) => void;
        await Promise.resolve(onData(data, peer, { rxGeneration }));
        return;
      }
      await engine.getHandshakeCarrier().inject(data, peer, { rxGeneration });
    };

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
      await deliver(flight, peer, 6);
      await setTimeout(50);

      // Assert: server は一切応答せず、handshake は開始前相のまま。
      expect(sentByServer).toHaveLength(0);
      expect(engine.hsPhase).toBe("wait_client_hello");

      // Act: 現世代 (7) の同一 flight は正常に処理される。
      await deliver(flight, peer, 7);
      await setTimeout(200);

      // Assert: server が ServerHello flight を返す。
      expect(sentByServer.length).toBeGreaterThan(0);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  20_000,
);

test.each(["transport.onData", "carrier.inject"] as const)(
  "e2e/self13 %s は同一 datagram 内の後続 record も restart 世代で破棄する",
  async (inboundPath) => {
    // Arrange: 実 DTLS 1.3 association を接続し、同一 epoch の暗号 record を
    // 2 件まとめて注入できる受信経路を用意する。
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;
    const server = new DtlsServer({
      transport: serverTransport,
      ...dtls13Options,
    });
    const client = new DtlsClient({
      transport: clientTransport,
      ...dtls13Options,
    });
    const connected = new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(
        () => reject(new Error("self13 handshake timeout")),
        10_000,
      );
      server.onConnect.once(() => {
        globalThis.clearTimeout(timer);
        resolve();
      });
      server.onError.once((error) => {
        globalThis.clearTimeout(timer);
        reject(error);
      });
    });
    let expectedGeneration = 7;
    const delivered: string[] = [];
    server.setExpectedRxGeneration(() => expectedGeneration);
    server.onData.subscribe((data) => {
      delivered.push(data.toString());
      if (delivered.length === 1) {
        // Act: 先行 record の callback 内で ICE restart 相当の世代変更を起こす。
        expectedGeneration++;
      }
    });

    try {
      // Act: client の実 DTLS handshake を完了させる。
      void client.connect().catch(() => undefined);
      await connected;

      const clientEngine = (
        client as unknown as {
          engine13?: {
            writeEpoch: number;
            epochs: Map<number, { writeKeys?: unknown; writeSequence: number }>;
          };
        }
      ).engine13;
      if (!clientEngine) throw new Error("client 1.3 engine が無い");
      const epoch = clientEngine.epochs.get(clientEngine.writeEpoch);
      if (!epoch?.writeKeys) throw new Error("client write key が無い");
      const first = encryptRecord(
        Buffer.from("fresh-first"),
        ContentType.applicationData,
        epoch as Parameters<typeof encryptRecord>[2],
      );
      const second = encryptRecord(
        Buffer.from("stale-second"),
        ContentType.applicationData,
        epoch as Parameters<typeof encryptRecord>[2],
      );
      const datagram = Buffer.concat([first, second]);
      // Act: 世代 7 として、2 record を同一 datagram のまま実受信経路へ渡す。
      if (inboundPath === "transport.onData") {
        const onData = serverTransport.onData as (
          data: Buffer,
          addr?: [string, number],
          meta?: { rxGeneration?: number },
        ) => void | Promise<void>;
        await onData(datagram, undefined, { rxGeneration: 7 });
      } else {
        const carrier = (
          server as unknown as {
            engine13?: {
              getHandshakeCarrier(): {
                inject(
                  data: Buffer,
                  peer?: [string, number],
                  opts?: { rxGeneration?: number },
                ): Promise<void>;
              };
            };
          }
        ).engine13?.getHandshakeCarrier();
        if (!carrier) throw new Error("server 1.3 carrier が無い");
        await carrier.inject(datagram, undefined, { rxGeneration: 7 });
      }

      // Assert: 先頭だけが配送され、後続の旧世代 record は同じ datagram
      // の中にあっても新世代へ漏れない。
      await setTimeout(0);
      expect(delivered).toEqual(["fresh-first"]);
    } finally {
      server.setExpectedRxGeneration(undefined);
      await Promise.allSettled([client.close(), server.close()]);
    }
  },
  20_000,
);
