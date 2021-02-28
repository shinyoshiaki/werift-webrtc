SCTP Implementation for TypeScript

# Example

```typescript
import { createSocket } from "dgram";
import { SCTP, WEBRTC_PPID, createUdpTransport } from "werift-sctp";

const port = 5555;

const socket = createSocket("udp4");
socket.bind(port);

const server = SCTP.server(createUdpTransport(socket));
server.onReceive = (_, __, data) => {
  console.log(data.toString());
  server.send(0, WEBRTC_PPID.STRING, Buffer.from("pong"));
};

const client = SCTP.client(
  createUdpTransport(createSocket("udp4"), {
    port,
    address: "127.0.0.1",
  })
);
client.onReceive = (_, __, data) => {
  console.log(data.toString());
};

await Promise.all([client.start(5000), server.start(5000)]);
await Promise.all([
  client.stateChanged.connected.asPromise(),
  server.stateChanged.connected.asPromise(),
]);

client.send(0, WEBRTC_PPID.STRING, Buffer.from("ping"));
```

# reference

-
- RFC4960
- RFC6083
- RFC6525
- RFC8261
- aiortc https://github.com/aiortc/aiortc
- pion/sctp https://github.com/pion/sctp
