import { DtlsClient } from "../src/client";
import { createUdpTransport } from "../src";
import { createSocket } from "dgram";
import { certPem, keyPem } from "../tests/fixture";

setTimeout(() => {
  const client = new DtlsClient({
    cert: certPem,
    key: keyPem,
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port: 4444,
    }),
    extendedMasterSecret: true,
  });
  client.onConnect.once(() => client.send(Buffer.from("hello")));
  client.onData.subscribe((data) => console.log(data.toString()));
  client.connect();
}, 100);

// openssl s_server -cert ./assets/cert.pem -key ./assets/key.pem -dtls1_2 -accept 127.0.0.1:4444 -state
