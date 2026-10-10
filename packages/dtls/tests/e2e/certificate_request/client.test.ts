import { UdpTransport } from "../../../../common/src";
import { DtlsClient } from "../../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../../src/cipher/const";
import { certPem, keyPem, spawnOpensslDtls12Server } from "../../fixture";

describe("e2e/certificate_request/client", () => {
  test("openssl", async () => {
    // Arrange: 空きポートで openssl s_server -dtls1_2 を起動する
    const server = await spawnOpensslDtls12Server();
    const transport = await UdpTransport.init("udp4");
    transport.rinfo = { address: "127.0.0.1", port: server.port };
    const client = new DtlsClient({
      transport,
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256_4,
        signature: SignatureAlgorithm.rsa_1,
      },
    });

    try {
      // Act: handshake 完了後に application data を送る
      // Assert: openssl 側の stdout に送信データが届く
      await new Promise<void>((resolve, reject) => {
        server.stdout.on("data", (data: string) => {
          if (data.includes("my_dtls")) resolve();
        });
        client.onConnect.subscribe(() => {
          void client.send(Buffer.from("my_dtls"));
        });
        client.onError.subscribe(reject);
        void client.connect().catch(reject);
      });
    } finally {
      client.close();
      server.close();
      await transport.close();
    }
  }, 10_000);
});
