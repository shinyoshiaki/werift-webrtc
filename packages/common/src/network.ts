import { createSocket, SocketType } from "dgram";

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

export async function randomPorts(num: number, protocol: SocketType = "udp4") {
  return Promise.all([...Array(num)].map(() => randomPort(protocol)));
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
