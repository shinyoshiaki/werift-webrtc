import { DtlsClient } from "../src/client";
import { createUdpTransport } from "../src";
import { createSocket } from "dgram";

setTimeout(() => {
  const client = new DtlsClient({
    transport: createUdpTransport(createSocket("udp4"), {
      address: "127.0.0.1",
      port: 4444,
    }),
  });
  client.onConnect = () => client.send(Buffer.from("hello"));
  client.connect();
}, 100);
