import { DtlsServer } from "../src/server";
import { readFileSync } from "fs";
import { createSocket } from "dgram";
import { createUdpTransport } from "../src";

const port = 6666;
const socket = createSocket("udp4");
socket.bind(port);

new DtlsServer({
  cert: readFileSync("assets/cert.pem").toString(),
  key: readFileSync("assets/key.pem").toString(),
  transport: createUdpTransport(socket),
});

// openssl s_client -dtls1_2 -connect 127.0.0.1:6666 -state
