import { createSocket, SocketType } from "dgram";

import { Connection, serverReflexiveCandidate } from "./ice";
import { StunProtocol } from "./stun/protocol";
import { Address } from "./types/model";

export async function randomPort(protocol: SocketType = "udp4") {
  const socket = createSocket(protocol);

  setImmediate(() => socket.bind(0));

  await new Promise<void>((r) => {
    socket.once("error", r);
    socket.once("listening", r);
  });

  const port = socket.address()?.port;
  await new Promise<void>((r) => socket.close(() => r()));
  return port;
}

export async function findPort(
  min: number,
  max: number,
  protocol: SocketType = "udp4"
) {
  let port: number | undefined;

  for (let i = min; i <= max; i++) {
    const socket = createSocket(protocol);

    setImmediate(() => socket.bind(i));

    await new Promise<void>((r) => {
      socket.once("error", r);
      socket.once("listening", r);
    });

    port = socket.address()?.port;
    await new Promise<void>((r) => socket.close(() => r()));
    if (min <= port && port <= max) {
      break;
    }
  }

  if (!port) throw new Error("port not found");

  return port;
}

export async function getGlobalIp(stunServer?: Address) {
  const connection = new Connection(true, {
    stunServer: stunServer ?? ["stun.l.google.com", 19302],
  });
  await connection.gatherCandidates();

  const protocol = new StunProtocol(connection);
  protocol.localCandidate = connection.localCandidates[0];
  await protocol.connectionMade(true);
  const candidate = await serverReflexiveCandidate(protocol, [
    "stun.l.google.com",
    19302,
  ]);

  await connection.close();
  await protocol.close();

  return candidate?.host;
}
