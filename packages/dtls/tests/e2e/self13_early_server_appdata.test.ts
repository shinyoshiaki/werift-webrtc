import { describe, expect, test } from "vitest";
import { UdpTransport } from "../../../common/src";
import { DtlsVersion } from "../../src";
import { SessionType } from "../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../src/engine/v1_3/connection";
import { certPem, keyPem } from "../fixture";

/**
 * RFC 9147 / TLS 1.3: server may send application data on epoch 3 after its
 * Finished, before receiving client Finished (early server data). Client must
 * buffer or deliver after connect — we buffer then flush on markConnected.
 */
describe("e2e/self13 early server application data", () => {
  test("server app data after server Finished is delivered to client", async () => {
    // Arrange: 前提を準備する
    const serverTransport = await UdpTransport.init("udp4");
    const clientTransport = await UdpTransport.init("udp4");
    clientTransport.rinfo = serverTransport.address;

    const server = new Dtls13Connection(
      {
        transport: serverTransport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
        offeredProtocolVersions: [DtlsVersion.V1_3],
      },
      SessionType.SERVER,
    );
    const client = new Dtls13Connection(
      {
        transport: clientTransport,
        cert: certPem,
        key: keyPem,
        addressValidation: "none",
        offeredProtocolVersions: [DtlsVersion.V1_3],
      },
      SessionType.CLIENT,
    );

    // Slow client epoch-2 processing so server can emit early app data first
    const clientAny = client as any;
    const origProcess = clientAny.processHandshakeBytes.bind(client);
    let delayed = false;
    clientAny.processHandshakeBytes = async (bytes: Buffer, epoch: number) => {
      if (epoch === 2 && !delayed) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return origProcess(bytes, epoch);
    };

    const earlyPayload = Buffer.from("early-from-server");
    let earlyDelivered = false;

    await new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("early server app data timeout")),
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

      client.onData.subscribe((data) => {
        if (data.equals(earlyPayload)) {
          earlyDelivered = true;
        }
      });

      client.onConnect.subscribe(() => {
        // Assert: 暗号ベクトルを検証する
        void (async () => {
          // Allow microtask flush of earlyAppData
          await new Promise((r) => setTimeout(r, 50));
          try {
            expect(earlyDelivered).toBe(true);
            clearTimeout(timer);
            client.close();
            server.close();
            resolve();
          } catch (e) {
            clearTimeout(timer);
            reject(e);
          }
        })();
      });

      // Act: 暗号ベクトルを検証する
      // before client Finished (server not yet connected)
      const sendEarlyWhenReady = async () => {
        for (let i = 0; i < 100; i++) {
          if (server["writeEpoch"] >= 3 && !server.connected) {
            await server.send(earlyPayload);
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("server never reached writeEpoch 3 before connect");
      };

      void sendEarlyWhenReady().catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
      await client.connect();
    });
  }, 20_000);
});
