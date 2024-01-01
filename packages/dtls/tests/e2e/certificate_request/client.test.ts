import { spawn } from "child_process";
import { createSocket } from "dgram";

import { DtlsClient, createUdpTransport } from "../../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../../src/cipher/const";
import { certPem, keyPem } from "../../fixture";

describe("e2e/certificate_request/client", () => {
  const port = 55559;
  test("openssl", (done) => {
    const args = [
      "s_server",
      "-cert",
      "./assets/cert.pem",
      "-key",
      "./assets/key.pem",
      "-dtls1_2",
      "-accept",
      `127.0.0.1:${port}`,
    ];

    const server = spawn("openssl", args);
    server.stdout.setEncoding("ascii");

    setTimeout(() => {
      const client = new DtlsClient({
        transport: createUdpTransport(createSocket("udp4"), {
          address: "127.0.0.1",
          port,
        }),
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
  }, 10_000);
});
