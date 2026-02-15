import { createSocket } from "dgram";
import { setTimeout as delay } from "timers/promises";

import { SCTP, WEBRTC_PPID, createUdpTransport } from "../src";

const activeTimerHandles = () =>
  ((process as any)._getActiveHandles?.() ?? []).filter((handle: any) => {
    const name = handle?.constructor?.name;
    return name === "Timeout" || name === "Immediate";
  }).length;

const withTimeout = async (promise: Promise<void>, ms: number) =>
  Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`timed out waiting for message exchange (${ms}ms)`);
    }),
  ]);

const main = async () => {
  const port = 61000 + Math.floor(Math.random() * 1000);
  const serverSocket = createSocket("udp4");
  const clientSocket = createSocket("udp4");
  const server = SCTP.server(createUdpTransport(serverSocket));
  const client = SCTP.client(
    createUdpTransport(clientSocket, {
      port,
      address: "127.0.0.1",
    })
  );

  try {
    await new Promise<void>((resolve, reject) => {
      serverSocket.once("error", reject);
      serverSocket.bind(port, resolve);
    });

    const messageCount = 50;
    let receivedByServer = 0;
    let receivedByClient = 0;
    let resolveDone!: () => void;
    const exchanged = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const maybeDone = () => {
      if (receivedByServer === messageCount && receivedByClient === messageCount) {
        resolveDone();
      }
    };

    server.onReceive.subscribe((_, __, data) => {
      if (data.toString().startsWith("from-client-")) {
        receivedByServer += 1;
        maybeDone();
      }
    });
    client.onReceive.subscribe((_, __, data) => {
      if (data.toString().startsWith("from-server-")) {
        receivedByClient += 1;
        maybeDone();
      }
    });

    await Promise.all([client.start(5000), server.start(5000)]);
    await Promise.all([
      client.stateChanged.connected.asPromise(),
      server.stateChanged.connected.asPromise(),
    ]);

    const baseline = activeTimerHandles();
    await Promise.all([
      ...Array.from({ length: messageCount }, (_, i) =>
        client.send(0, WEBRTC_PPID.STRING, Buffer.from(`from-client-${i}`))
      ),
      ...Array.from({ length: messageCount }, (_, i) =>
        server.send(0, WEBRTC_PPID.STRING, Buffer.from(`from-server-${i}`))
      ),
    ]);
    await withTimeout(exchanged, 5000);

    await Promise.all([client.stop(), server.stop()]);
    client.transport.close();
    server.transport.close();
    await delay(50);

    if (client.transport.onData !== undefined || server.transport.onData !== undefined) {
      throw new Error("transport.onData must be undefined after stop");
    }

    const after = activeTimerHandles();
    if (after > baseline) {
      throw new Error(
        `timer handle leak detected: baseline=${baseline}, after=${after}`
      );
    }
  } finally {
    if ((serverSocket as any).listening) {
      serverSocket.close();
    }
    if ((clientSocket as any).listening) {
      clientSocket.close();
    }
  }
};

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
