import { spawn } from "child_process";
import { DtlsServer } from "../../src/server";
import { createSocket } from "dgram";
import { createUdpTransport } from "../../src";
import { certPem, keyPem } from "../fixture";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/cipher/const";

describe("e2e/server", () => {
  test("openssl", (done) => {
    const port = 55556;
    const socket = createSocket("udp4");
    socket.bind(port);
    const server = new DtlsServer({
      cert: certPem,
      key: keyPem,
      signatureHash: {
        hash: HashAlgorithm.sha256,
        signature: SignatureAlgorithm.rsa,
      },
      transport: createUdpTransport(socket),
    });
    server.onConnect.subscribe(() => {
      server.send(Buffer.from("my_dtls_server"));
    });

    setTimeout(() => {
      const client = spawn("openssl", [
        "s_client",
        "-dtls1_2",
        "-connect",
        "127.0.0.1:55556",
      ]);
      client.stdout.setEncoding("ascii");
      client.stdout.on("data", (data: string) => {
        if (data.includes("my_dtls_server")) {
          socket.close();
          server.close();
          done();
        }
      });
    }, 100);
  }, 10_000);
});
