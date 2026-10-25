import { readFileSync } from "fs";

import { SCTP, SCTPSendPermissionRevokedError } from "../src";
import { CookieEchoChunk, InitAckChunk, InitChunk, parsePacket, serializePacket } from "../src/chunk";
import type { DataChunk } from "../src/chunk";
import { FifoQueue } from "../src/imports/common";
import type { Transport } from "../src/transport";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/**
 * Arrange: transport whose sends can be held open or made to fail, so tests
 * can interleave cancellation with an in-flight chunk.
 */
export function createControlledTransport() {
  const sent: Buffer[] = [];
  let hold: Promise<void> | undefined;
  let release = () => {};
  let failSends: "loss" | "revoked" | undefined;
  const transport: Transport = {
    send: async (data: Buffer) => {
      if (failSends === "revoked") {
        throw new SCTPSendPermissionRevokedError("transport rejected");
      }
      if (failSends === "loss") throw new Error("transport rejected");
      sent.push(data);
      if (hold) await hold;
    },
    close: () => {},
  };
  return {
    transport,
    sent,
    /** Keep subsequent sends pending until `release()`. */
    holdSends: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => {
      hold = undefined;
      release();
    },
    /**
     * Make subsequent sends reject. `loss` is an ordinary send failure;
     * `revoked` is the transport withdrawing the start's send permission.
     */
    failSends: (kind: "loss" | "revoked" = "loss") => {
      failSends = kind;
    },
    restoreSends: () => {
      failSends = undefined;
    },
  };
}

/** Arrange: deliver an INIT_ACK (with state cookie) to an initiator in COOKIE_WAIT. */
export async function receiveInitAck(sctp: SCTP) {
  const ack = new InitAckChunk();
  ack.initiateTag = 0x1234;
  ack.advertisedRwnd = 131072;
  ack.outboundStreams = 65535;
  ack.inboundStreams = 65535;
  ack.initialTsn = 1;
  ack.params.push([0x0007, Buffer.from("cookie")]);
  const packet = serializePacket(
    5001,
    5000,
    (sctp as unknown as { localVerificationTag: number }).localVerificationTag,
    ack,
  );
  await (
    sctp as unknown as { handleData: (data: Buffer) => Promise<void> }
  ).handleData(packet);
}

type SctpInternals = {
  localVerificationTag: number;
  handleData: (data: Buffer) => Promise<void>;
};

/**
 * Arrange: drive a responder through INIT so it issues a state cookie.
 * Returns the cookie from the INIT_ACK it sent.
 */
export async function receiveInitAndTakeCookie(
  sctp: SCTP,
  sent: Buffer[],
): Promise<Buffer> {
  const init = new InitChunk();
  init.initiateTag = 0x5678;
  init.advertisedRwnd = 131072;
  init.outboundStreams = 65535;
  init.inboundStreams = 65535;
  init.initialTsn = 1;
  await (sctp as unknown as SctpInternals).handleData(
    serializePacket(5001, 5000, 0, init),
  );
  const initAck = parsePacket(sent[sent.length - 1])[3][0] as InitAckChunk;
  return initAck.params.find(([type]) => type === 0x0007)![1];
}

/** Arrange: deliver a COOKIE_ECHO carrying `cookie` to a responder. */
export async function receiveCookieEcho(sctp: SCTP, cookie: Buffer) {
  const echo = new CookieEchoChunk();
  echo.body = cookie;
  const internals = sctp as unknown as SctpInternals;
  await internals.handleData(
    serializePacket(5001, 5000, internals.localVerificationTag, echo),
  );
}

/** Arrange: chunk types carried by the packets a transport has sent. */
export function sentChunkTypes(sent: Buffer[]) {
  return sent.map((packet) => parsePacket(packet)[3][0].type);
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
