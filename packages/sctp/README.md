# werift-sctp

SCTP Implementation for TypeScript  
based on aiortc/sctp

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

## Session Migration

werift-sctp supports session state serialization and restoration, allowing you to migrate SCTP sessions between different processes or network endpoints while preserving connection state.

### Usage

```typescript
import { SCTP } from "werift-sctp";

// Export session state
const stateBuffer = sctpSession.exportState();

// Restore session with new transport
const newSession = SCTP.restoreState(stateBuffer, newTransport);
```

### Example

```typescript
import { createSocket } from "dgram";
import { SCTP, WEBRTC_PPID, createUdpTransport } from "werift-sctp";
import { randomPort } from "werift-common";

async function sessionMigrationExample() {
  const clientPort = await randomPort();
  const serverPort = await randomPort();
  
  // Create initial session
  const sctpA = SCTP.client(
    createUdpTransport(createSocket("udp4").bind(clientPort), {
      port: serverPort,
      address: "127.0.0.1",
    }),
  );
  
  const sctpB = SCTP.server(
    createUdpTransport(createSocket("udp4").bind(serverPort), {
      port: clientPort,
      address: "127.0.0.1",
    }),
  );
  
  // Establish connection
  await Promise.all([sctpA.start(), sctpB.start()]);
  
  // Send data
  await sctpA.send(0, WEBRTC_PPID.STRING, Buffer.from("Hello"));
  
  // Export session state
  const stateBuffer = sctpA.exportState();
  
  // Create new transport for migration
  const newClientPort = await randomPort();
  const newTransport = createUdpTransport(createSocket("udp4").bind(newClientPort), {
    port: serverPort,
    address: "127.0.0.1",
  });
  
  // Restore session
  const sctpA2 = SCTP.restoreState(stateBuffer, newTransport);
  
  // Update server's remote port
  sctpB.setRemotePort(newClientPort);
  
  // Stop old session
  await sctpA.stop();
  
  // Continue communication with migrated session
  await sctpA2.send(0, WEBRTC_PPID.STRING, Buffer.from("Migrated Hello"));
  
  // Cleanup
  await sctpA2.stop();
  await sctpB.stop();
}
```

### Features

- **Complete state preservation**: All session state including streams, sequence numbers, and connection parameters are preserved
- **MessagePack serialization**: Efficient binary serialization using MessagePack
- **Multiple stream support**: Stream state is maintained across migration
- **Transport flexibility**: Works with any transport implementation

# reference

-
- RFC4960
- RFC6083
- RFC6525
- RFC8261
- aiortc https://github.com/aiortc/aiortc
- pion/sctp https://github.com/pion/sctp
