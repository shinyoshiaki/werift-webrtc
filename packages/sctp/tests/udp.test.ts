import { createSocket } from "dgram";

import { SCTP, WEBRTC_PPID } from "../src";
import { createUdpTransport } from "../src/transport";

test("udp", async (done) => {
  const port = 5556;

  const socket = createSocket("udp4");
  socket.bind(port);
  const server = SCTP.server(createUdpTransport(socket));
  server.onReceive.subscribe((_, __, data) => {
    expect(data.toString()).toBe("ping");
    server.send(0, WEBRTC_PPID.STRING, Buffer.from("pong"));
  });

  const client = SCTP.client(
    createUdpTransport(createSocket("udp4"), {
      port,
      address: "127.0.0.1",
    })
  );
  client.onReceive.subscribe((_, __, data) => {
    expect(data.toString()).toBe("pong");
    socket.close();
    done();
  });

  await Promise.all([client.start(5000), server.start(5000)]);
  await Promise.all([
    client.stateChanged.connected.asPromise(),
    server.stateChanged.connected.asPromise(),
  ]);

  client.send(0, WEBRTC_PPID.STRING, Buffer.from("ping"));
});
