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
