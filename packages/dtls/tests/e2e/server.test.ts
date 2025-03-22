import { spawn } from "child_process";

import { UdpTransport } from "../../../common/src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";
import { CipherContext } from "../../src/context/cipher";
import { DtlsServer } from "../../src/server";
import { certPem, keyPem } from "../fixture";

describe("e2e/server", () => {
  test(
    "openssl",
    () =>
      new Promise<void>(async (done) => {
        const transport = await UdpTransport.init("udp4");
        const server = new DtlsServer({
          cert: certPem,
          key: keyPem,
          signatureHash: {
            hash: HashAlgorithm.sha256_4,
            signature: SignatureAlgorithm.rsa_1,
          },
          transport,
        });
        server.onConnect.subscribe(() => {
          server.send(Buffer.from("my_dtls_server"));
        });

        setTimeout(() => {
          const client = spawn("openssl", [
            "s_client",
            "-dtls1_2",
            "-connect",
            `127.0.0.1:${transport.port}`,
          ]);
          client.stdout.setEncoding("ascii");
          client.stdout.on("data", (data: string) => {
            if (data.includes("my_dtls_server")) {
              transport.close();
              server.close();
              done();
            }
          });
        }, 100);
      }),
    10_000,
  );

  test(
    "openssl use self sign certificate",
    async () =>
      new Promise<void>(async (done) => {
        const transport = await UdpTransport.init("udp4");

        const server = new DtlsServer({
          transport,
        });
        server.onConnect.subscribe(() => {
          server.send(Buffer.from("my_dtls_server"));
        });
        const { certPem, keyPem, signatureHash } =
          await CipherContext.createSelfSignedCertificateWithKey({
            hash: HashAlgorithm.sha256_4,
            signature: SignatureAlgorithm.rsa_1,
          });
        server.cipher.parseX509(certPem, keyPem, signatureHash);

        setTimeout(() => {
          const client = spawn("openssl", [
            "s_client",
            "-dtls1_2",
            "-connect",
            `127.0.0.1:${transport.port}`,
          ]);
          client.stdout.setEncoding("ascii");
          client.stdout.on("data", (data: string) => {
            if (data.includes("my_dtls_server")) {
              transport.close();
              server.close();
              done();
            }
          });
        }, 100);
      }),
    10_000,
  );
});
