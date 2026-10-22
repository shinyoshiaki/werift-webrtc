import { readFileSync } from "fs";

import { SCTP } from "../src";
import type { DataChunk } from "../src/chunk";
import { FifoQueue } from "../src/imports/common";
import type { Transport } from "../src/transport";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/** Builds the queue type SCTP keeps sent / outbound DATA chunks in. */
export const createChunkQueue = (chunks: DataChunk[] = []) =>
  new FifoQueue<DataChunk>(chunks);

/**
 * In-memory datagram transport. Packets are delivered to the peer on a later
 * macrotask (setImmediate) like a real socket would, so timers keep running.
 */
export class MemoryTransport implements Transport {
  onData?: (buf: Buffer) => void;
  peer?: MemoryTransport;
  closed = false;
  sentPackets = 0;
  droppedPackets = 0;

  /** Return true to drop the packet (index = number of packets sent before). */
  constructor(
    private readonly drop?: (buf: Buffer, index: number) => boolean,
  ) {}

  send = async (buf: Buffer) => {
    const index = this.sentPackets++;
    if (this.closed) return;
    if (this.drop?.(buf, index)) {
      this.droppedPackets++;
      return;
    }
    const peer = this.peer;
    setImmediate(() => {
      if (peer && !peer.closed) peer.onData?.(buf);
    });
  };

  close() {
    this.closed = true;
  }
}

export const createMemoryTransportPair = (
  options: {
    dropClient?: (buf: Buffer, index: number) => boolean;
    dropServer?: (buf: Buffer, index: number) => boolean;
  } = {},
) => {
  const client = new MemoryTransport(options.dropClient);
  const server = new MemoryTransport(options.dropServer);
  client.peer = server;
  server.peer = client;
  return { client, server };
};

/** Creates a client/server SCTP pair over memory transports and waits until both are connected. */
export const createConnectedSctpPair = async (
  options: Parameters<typeof createMemoryTransportPair>[0] = {},
) => {
  const transports = createMemoryTransportPair(options);
  const client = SCTP.client(transports.client);
  const server = SCTP.server(transports.server);

  const connected = Promise.all([
    client.stateChanged.connected.asPromise(),
    server.stateChanged.connected.asPromise(),
  ]);
  await Promise.all([client.start(5000), server.start(5000)]);
  await connected;

  const stop = async () => {
    await client.stop();
    await server.stop();
    transports.client.close();
    transports.server.close();
  };

  return { client, server, transports, stop };
};

/** Deterministic payloads; message i carries its index in the first 4 bytes. */
export const createMessages = (count: number, size: number) =>
  [...Array(count)].map((_, i) => {
    const buf = Buffer.alloc(Math.max(4, size), i % 251);
    buf.writeUInt32BE(i, 0);
    return buf;
  });

/** Collects messages received by an SCTP endpoint until `count` arrived. */
export const collectMessages = (sctp: SCTP, count: number) => {
  const received: Buffer[] = [];
  const done = new Promise<Buffer[]>((resolve) => {
    if (count === 0) resolve(received);
    sctp.onReceive.subscribe((_streamId, _ppId, data) => {
      received.push(data);
      if (received.length === count) resolve(received);
    });
  });
  return { received, done };
};

/**
 * Measures how long the event loop is blocked: a heartbeat interval records
 * the maximum delay between its expected and actual firing.
 */
export const startEventLoopLagMonitor = (intervalMs = 10) => {
  let maxLagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    get maxLagMs() {
      return maxLagMs;
    },
    stop: () => {
      clearInterval(timer);
      return maxLagMs;
    },
  };
};

/**
 * Queues `count` messages at once on `sender` and waits until `receiver`
 * got all of them. Returns elapsed time and the event loop lag during transfer.
 */
export const runBurstTransfer = async (
  sender: SCTP,
  receiver: SCTP,
  messages: Buffer[],
  ppId = 53,
) => {
  const { done } = collectMessages(receiver, messages.length);
  const monitor = startEventLoopLagMonitor();
  const started = performance.now();
  const sends = messages.map((m) => sender.send(0, ppId, m));
  const received = await done;
  await Promise.all(sends);
  const elapsedMs = performance.now() - started;
  const maxLagMs = monitor.stop();
  return { received, elapsedMs, maxLagMs };
};

/**
 * Drop predicate for MemoryTransport: drops the DATA packets (first chunk
 * type 0) whose 0-based DATA packet index is in `indexes`.
 */
export const dropDataPacketsAt = (indexes: number[]) => {
  const targets = new Set(indexes);
  let dataIndex = 0;
  return (buf: Buffer) => {
    if (buf.length <= 12 || buf[12] !== 0) return false;
    return targets.has(dataIndex++);
  };
};

/** Runs a burst of `count` messages on a fresh pair and returns the elapsed time. */
export const measureBurstTransfer = async (count: number, size: number) => {
  const pair = await createConnectedSctpPair();
  try {
    return await runBurstTransfer(
      pair.client,
      pair.server,
      createMessages(count, size),
    );
  } finally {
    await pair.stop();
  }
};
