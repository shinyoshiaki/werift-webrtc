import { spawn } from "child_process";
import { createSocket } from "dgram";

import { UdpTransport } from "../../../common/src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { DtlsClient } from "../../src/client";
import { certPem, keyPem } from "../fixture";

describe("e2e/client", () => {
  test(
    "openssl",
    (done) =>
      new Promise<void>((done) => {
        const args = [
          "s_server",
          "-cert",
          "./assets/cert.pem",
          "-key",
          "./assets/key.pem",
          "-dtls1_2",
          "-accept",
          "127.0.0.1:55555",
        ];

        const server = spawn("openssl", args);
        server.stdout.setEncoding("ascii");

        setTimeout(async () => {
          const transport = await UdpTransport.init("udp4");
          transport.rinfo = { address: "127.0.0.1", port: 55555 };
          const client = new DtlsClient({
            transport,
            cert: certPem,
            key: keyPem,
            signatureHash: {
              hash: HashAlgorithm.sha256_4,
              signature: SignatureAlgorithm.rsa_1,
            },
          });
          client.onConnect.subscribe(() => {
            client.send(Buffer.from("my_dtls"));
          });
          client.connect();
          server.stdout.on("data", (data: string) => {
            if (data.includes("my_dtls")) {
              done();
              client.close();
            }
          });
        }, 100);
      }),
    10_000,
  );
});
