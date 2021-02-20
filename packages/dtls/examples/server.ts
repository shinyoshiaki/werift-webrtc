import { DtlsServer } from "../src/server";
import { createSocket } from "dgram";
import { createUdpTransport } from "../src";
import { certPem, keyPem } from "../tests/fixture";

const port = 6666;
const socket = createSocket("udp4");
socket.bind(port);

const server = new DtlsServer({
  cert: certPem,
  key: keyPem,
  transport: createUdpTransport(socket),
});
server.onData.subscribe((data) => console.log(data.toString()));
server.onConnect.once(() => server.send(Buffer.from("hello")));
// openssl s_client -dtls1_2 -connect 127.0.0.1:6666 -state
