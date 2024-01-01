import { spawn } from "child_process";

import { createSocket } from "dgram";
import { readFileSync } from "fs";
import { DtlsServer, createUdpTransport } from "../../../src";

describe("e2e/certificate_request/server", () => {
  test("openssl", (done) => {
    const port = 55560;
    const socket = createSocket("udp4");
    socket.bind(port);
    const server = new DtlsServer({
      cert: readFileSync("assets/cert.pem").toString(),
      key: readFileSync("assets/key.pem").toString(),
      transport: createUdpTransport(socket),
      certificateRequest: true,
    });
    server.onConnect.once(() => {
      server.send(Buffer.from("my_dtls_server"));
    });

    setTimeout(() => {
      const client = spawn("openssl", [
        "s_client",
        "-dtls1_2",
        "-connect",
        `127.0.0.1:${port}`,
      ]);
      client.stdout.setEncoding("ascii");
      client.stdout.on("data", (data: string) => {
        if (data.includes("my_dtls_server")) {
          done();
          server.close();
        }
      });
      client.stdout.on("error", (err) => {
        console.log(err);
      });
    }, 100);
  });
});
