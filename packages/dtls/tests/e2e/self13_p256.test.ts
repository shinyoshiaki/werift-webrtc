import { UdpTransport } from "../../../common/src";
import { DtlsClient, DtlsServer, DtlsVersion } from "../../src";
import { NamedCurveAlgorithm } from "../../src/cipher/const";
import { SessionType } from "../../src/cipher/suites/abstract";
import { Dtls13Connection } from "../../src/engine/v1_3/connection";
import { certPem, keyPem } from "../fixture";

/**
 * P-256 key share path via direct Dtls13Connection (groups option).
 */
test("e2e/self13 P-256 key share bidirectional data", async () => {
  // Arrange: 前提を準備する
  const serverTransport = await UdpTransport.init("udp4");
  const clientTransport = await UdpTransport.init("udp4");
  clientTransport.rinfo = serverTransport.address;

  const groups = [NamedCurveAlgorithm.secp256r1_23];
  const server = new Dtls13Connection(
    {
      transport: serverTransport,
      cert: certPem,
      key: keyPem,
      groups,
      addressValidation: "none",
    },
    SessionType.SERVER,
  );
  const client = new Dtls13Connection(
    {
      transport: clientTransport,
      cert: certPem,
      key: keyPem,
      groups,
      addressValidation: "none",
    },
    SessionType.CLIENT,
  );

  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("p256 timeout")), 15_000);
    server.onData.subscribe((data) => {
      // Assert: 期待どおりの結果を検証する
      expect(data.toString()).toBe("p256");
      void server.send(Buffer.from("p256_ok"));
    });
    client.onData.subscribe((data) => {
      expect(data.toString()).toBe("p256_ok");
      clearTimeout(timer);
      client.close();
      server.close();
      resolve();
    });
    client.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    server.onError.subscribe((e) => {
      clearTimeout(timer);
      reject(e);
    });
    client.onConnect.subscribe(() => {
      void client.send(Buffer.from("p256"));
    });

    // Act: 期待どおりの結果を検証する
    await client.connect();
  });
}, 20_000);

// Public API still defaults without groups option
void DtlsClient;
void DtlsServer;
void DtlsVersion;
