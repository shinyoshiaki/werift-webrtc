import { createSocket, SocketType } from "dgram";

export type InterfaceAddresses = {
  [K in SocketType]?: string;
};

export const interfaceAddress = (
  type: SocketType,
  interfaceAddresses: InterfaceAddresses | undefined
) => (interfaceAddresses ? interfaceAddresses[type] : undefined);

export async function randomPort(
  protocol: SocketType = "udp4",
  interfaceAddresses?: InterfaceAddresses
) {
  const socket = createSocket(protocol);

  setImmediate(() =>
    socket.bind({
      port: 0,
      address: interfaceAddress(protocol, interfaceAddresses),
    })
  );

  await new Promise<void>((r) => {
    socket.once("error", r);
    socket.once("listening", r);
  });

  const port = socket.address()?.port;
  await new Promise<void>((r) => socket.close(() => r()));
  return port;
}

export async function randomPorts(
  num: number,
  protocol: SocketType = "udp4",
  interfaceAddresses?: InterfaceAddresses
) {
  return Promise.all(
    [...Array(num)].map(() => randomPort(protocol, interfaceAddresses))
  );
}

export async function findPort(
  min: number,
  max: number,
  protocol: SocketType = "udp4",
  interfaceAddresses?: InterfaceAddresses
) {
  let port: number | undefined;

  for (let i = min; i <= max; i++) {
    const socket = createSocket(protocol);

    setImmediate(() =>
      socket.bind({
        port: i,
        address: interfaceAddress(protocol, interfaceAddresses),
      })
    );

    const err = await new Promise<Error | void>((r) => {
      socket.once("error", (e) => r(e));
      socket.once("listening", () => r());
    });
    if (err) {
      continue;
    }

    port = socket.address()?.port;
    await new Promise<void>((r) => socket.close(() => r()));
    if (min <= port && port <= max) {
      break;
    }
  }

  if (!port) throw new Error("port not found");

  return port;
}
