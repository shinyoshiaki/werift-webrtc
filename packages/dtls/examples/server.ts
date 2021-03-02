import { DtlsServer } from "../src/server";
import { createSocket } from "dgram";
import { createUdpTransport } from "../src";
import * as x509 from "@peculiar/x509";
import { Crypto } from "@peculiar/webcrypto";

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

const port = 6666;
const socket = createSocket("udp4");
socket.bind(port);

(async () => {
  const server = new DtlsServer({
    transport: createUdpTransport(socket),
    extendedMasterSecret: true,
  });
  server.onData.subscribe((data) => console.log(data.toString()));
  server.onConnect.once(() => server.send(Buffer.from("hello")));
})();

// openssl s_client -dtls1_2 -connect 127.0.0.1:6666 -state
