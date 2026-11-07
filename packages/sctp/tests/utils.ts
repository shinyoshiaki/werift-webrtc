import { readFileSync } from "fs";

import { SCTP, SCTP_STATE } from "../src";
import {
  type Chunk,
  DataChunk,
  ForwardTsnChunk,
  parsePacket,
  ReconfigChunk,
  serializePacket,
} from "../src/chunk";
import { FifoQueue } from "../src/imports/common";
import {
  OutgoingSSNResetRequestParam,
  ReconfigResponseParam,
} from "../src/param";
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
  private readonly drop?: (buf: Buffer, index: number) => boolean;

  onData?: (buf: Buffer) => void;
  peer?: MemoryTransport;
  closed = false;
  sentPackets = 0;
  droppedPackets = 0;

  /** Return true to drop the packet (index = number of packets sent before). */
  constructor(
    drop?: (buf: Buffer, index: number) => boolean,
  ) {
    this.drop = drop;
  }

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

// # stream reset (RFC 6525) helpers

const DATA_FLAG_LAST_FRAG = 0x01;
const DATA_FLAG_FIRST_FRAG = 0x02;
const DATA_FLAG_UNORDERED = 0x04;

/** Builds one DATA chunk. `fragment` selects the B/E flags (default: whole message). */
export const createDataChunk = ({
  tsn,
  streamId = 1,
  ssn = 0,
  data = "x",
  fragment = "whole",
  unordered = false,
}: {
  tsn: number;
  streamId?: number;
  ssn?: number;
  data?: string;
  fragment?: "whole" | "first" | "middle" | "last";
  unordered?: boolean;
}) => {
  const chunk = new DataChunk(0, undefined);
  chunk.flags =
    (fragment === "whole" || fragment === "first" ? DATA_FLAG_FIRST_FRAG : 0) |
    (fragment === "whole" || fragment === "last" ? DATA_FLAG_LAST_FRAG : 0) |
    (unordered ? DATA_FLAG_UNORDERED : 0);
  chunk.tsn = tsn;
  chunk.streamId = streamId;
  chunk.streamSeqNum = ssn;
  chunk.protocol = 51;
  chunk.userData = Buffer.from(data);
  return chunk;
};

/** Builds a RE-CONFIG chunk carrying one Outgoing SSN Reset Request. */
export const createResetRequestChunk = ({
  requestSequence,
  lastTsn,
  streams,
  responseSequence = 0,
}: {
  requestSequence: number;
  lastTsn: number;
  streams: number[];
  responseSequence?: number;
}) => {
  const param = new OutgoingSSNResetRequestParam(
    requestSequence,
    responseSequence,
    lastTsn,
    streams,
  );
  const chunk = new ReconfigChunk();
  chunk.params.push([param.type, param.bytes]);
  return chunk;
};

/** Builds a RE-CONFIG chunk carrying one Re-configuration Response. */
export const createReconfigResponseChunk = (
  responseSequence: number,
  result: number,
) => {
  const param = new ReconfigResponseParam(responseSequence, result as never);
  const chunk = new ReconfigChunk();
  chunk.params.push([param.type, param.bytes]);
  return chunk;
};

export const createForwardTsnChunk = (
  cumulativeTsn: number,
  streams: [number, number][] = [],
) => {
  const chunk = new ForwardTsnChunk(0, undefined);
  chunk.cumulativeTsn = cumulativeTsn;
  chunk.streams = streams;
  return chunk;
};

/** Reconfig params of a type in the packets an endpoint sent, in send order. */
const sentReconfigParams = (packets: Buffer[], type: number) =>
  packets.flatMap((packet) =>
    parsePacket(packet)[3]
      .filter((chunk) => chunk.type === ReconfigChunk.type)
      .flatMap((chunk) => (chunk as ReconfigChunk).params)
      .filter(([paramType]) => paramType === type)
      .map(([, body]) => body),
  );

export type SctpEvent =
  | { type: "message"; streamId: number; data: string }
  | { type: "reset"; streamIds: number[] };

/** Records onReceive / onReconfigStreams in the order they fire. */
export const recordSctpEvents = (sctp: SCTP) => {
  const events: SctpEvent[] = [];
  sctp.onReceive.subscribe((streamId, _ppId, data) => {
    events.push({ type: "message", streamId, data: data.toString() });
  });
  sctp.onReconfigStreams.subscribe((streamIds) => {
    events.push({ type: "reset", streamIds });
  });
  return events;
};

/**
 * An ESTABLISHED SCTP endpoint on a recording mock transport. Packets are
 * injected through the regular receive path (handleData), and the peer's
 * cumulative TSN / last processed reconfig request seq are preset.
 */
export const createEstablishedMockSctp = ({
  lastReceivedTsn = 100,
  reconfigResponseSeq = 1000,
}: { lastReceivedTsn?: number; reconfigResponseSeq?: number } = {}) => {
  const sent: Buffer[] = [];
  const transport: Transport = {
    send: async (buf: Buffer) => {
      sent.push(buf);
    },
    close: () => {},
  };
  const sctp = SCTP.client(transport, 5000);
  sctp.setRemotePort(5001);
  const internal = sctp as any;
  internal.associationState = SCTP_STATE.ESTABLISHED;
  internal.lastReceivedTsn = lastReceivedTsn;
  sctp.reconfigResponseSeq = reconfigResponseSeq;

  const events = recordSctpEvents(sctp);

  const inject = async (...chunks: Chunk[]) => {
    for (const chunk of chunks) {
      await internal.handleData(
        serializePacket(5001, 5000, internal.localVerificationTag, chunk),
      );
    }
  };

  return {
    sctp,
    internal,
    events,
    inject,
    /** Re-configuration Responses sent to the peer. */
    responses: () =>
      sentReconfigParams(sent, ReconfigResponseParam.type).map((body) =>
        ReconfigResponseParam.parse(body),
      ),
    /** Outgoing SSN Reset Requests sent to the peer (reverse resets). */
    resetRequests: () =>
      sentReconfigParams(sent, OutgoingSSNResetRequestParam.type).map((body) =>
        OutgoingSSNResetRequestParam.parse(body),
      ),
  };
};
