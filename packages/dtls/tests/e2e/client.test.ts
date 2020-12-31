import { spawn } from "child_process";
import { DtlsClient } from "../../src/client";
import { createSocket } from "dgram";
import { createUdpTransport } from "../../src";

describe("e2e/client", () => {
  test("openssl", (done) => {
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

    setTimeout(() => {
      const client = new DtlsClient({
        transport: createUdpTransport(createSocket("udp4"), {
          address: "127.0.0.1",
          port: 55555,
        }),
        cert: "",
        key: "",
      });
      client.onConnect = () => {
        client.send(Buffer.from("my_dtls"));
      };
      client.connect();
      server.stdout.on("data", (data: string) => {
        if (data.includes("my_dtls")) {
          done();
          client.close();
        }
      });
    }, 100);
  });
});
