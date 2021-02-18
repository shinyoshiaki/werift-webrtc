import { DtlsClient } from "../src/client";
import { createUdpTransport } from "../src";
import { createSocket } from "dgram";
import { readFileSync } from "fs";

setTimeout(() => {
  const client = new DtlsClient({
    cert: readFileSync("assets/cert.pem").toString(),
    key: readFileSync("assets/key.pem").toString(),
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port: 4444,
    }),
  });
  client.onConnect.once(() => client.send(Buffer.from("hello")));
  client.connect();
}, 100);

// openssl s_server -cert ./assets/cert.pem -key ./assets/key.pem -dtls1_2 -accept 127.0.0.1:4444 -state
