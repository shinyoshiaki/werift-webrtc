import { readFileSync } from "fs";
import { setImmediate as waitImmediate } from "timers/promises";
import { expect, type Mock, vi } from "vitest";

import { SCTP, SCTP_STATE } from "../src";
import {
  type Chunk,
  CookieEchoChunk,
  DataChunk,
  ForwardTsnChunk,
  InitAckChunk,
  InitChunk,
  parsePacket,
  ReconfigChunk,
  SackChunk,
  serializePacket,
} from "../src/chunk";
import { FifoQueue } from "../src/imports/common";
import {
  OutgoingSSNResetRequestParam,
  ReconfigResponseParam,
  reconfigResult,
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
  constructor(drop?: (buf: Buffer, index: number) => boolean) {
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
  const cpuStarted = process.cpuUsage();
  const sends = messages.map((m) => sender.send(0, ppId, m));
  const received = await done;
  await Promise.all(sends);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const cpuElapsedMs = (cpu.user + cpu.system) / 1000;
  const maxLagMs = monitor.stop();
  return { received, elapsedMs, cpuElapsedMs, maxLagMs };
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

/**
 * Drop predicate for MemoryTransport: drops the first `count` packets that
 * carry a Re-configuration Response with Success - Performed (lost response).
 */
export const dropReconfigSuccessResponses = (count = 1) => {
  let dropped = 0;
  return (buf: Buffer) => {
    if (dropped >= count) return false;
    const hasSuccess = parsePacket(buf)[3].some(
      (chunk) =>
        chunk.type === ReconfigChunk.type &&
        (chunk as ReconfigChunk).params.some(
          ([type, body]) =>
            type === ReconfigResponseParam.type &&
            ReconfigResponseParam.parse(body).result ===
              reconfigResult.ReconfigResultSuccessPerformed,
        ),
    );
    if (hasSuccess) dropped++;
    return hasSuccess;
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

type SctpInternals = {
  localVerificationTag: number;
  handleData: (data: Buffer) => Promise<void>;
};

/**
 * Arrange: transport whose sends can be held open or made to fail, so tests
 * can interleave incoming chunks or state changes with an in-flight chunk.
 */
export function createControlledTransport() {
  const sent: Buffer[] = [];
  let hold: Promise<void> | undefined;
  let release = () => {};
  let failSends = false;
  const transport: Transport = {
    send: async (data: Buffer) => {
      if (failSends) throw new Error("transport rejected");
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
    /** Make subsequent sends reject (an ordinary send failure). */
    failSends: () => {
      failSends = true;
    },
    restoreSends: () => {
      failSends = false;
    },
  };
}

/** Arrange: deliver an INIT_ACK (with state cookie) to an initiator in COOKIE_WAIT. */
export async function receiveInitAck(sctp: SCTP) {
  const ack = new InitAckChunk();
  ack.initiateTag = 0x5678;
  ack.advertisedRwnd = 131072;
  ack.outboundStreams = 65535;
  ack.inboundStreams = 65535;
  ack.initialTsn = 1;
  ack.params.push([0x0007, Buffer.from("cookie")]);
  const internals = sctp as unknown as SctpInternals;
  await internals.handleData(
    serializePacket(5001, 5000, internals.localVerificationTag, ack),
  );
}

/**
 * Arrange: deliver an INIT whose common-header verification tag is `tag`.
 * RFC 9260 requires 0; an older werift (<= 0.26) that answered our INIT
 * before its own start() sends its INIT with the tag it learned from ours.
 */
export async function receiveInitTagged(
  sctp: SCTP,
  tag: number,
  { initiateTag = 0x5678, initialTsn = 1 } = {},
) {
  const init = new InitChunk();
  init.initiateTag = initiateTag;
  init.advertisedRwnd = 131072;
  init.outboundStreams = 65535;
  init.inboundStreams = 65535;
  init.initialTsn = initialTsn;
  await (sctp as unknown as SctpInternals).handleData(
    serializePacket(5001, 5000, tag, init),
  );
}

/**
 * Arrange: drive a responder through INIT so it issues a state cookie.
 * Returns the cookie from the INIT_ACK it sent.
 */
export async function receiveInitAndTakeCookie(
  sctp: SCTP,
  sent: Buffer[],
): Promise<Buffer> {
  await receiveInitTagged(sctp, 0);
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

/** Arrange: the verification tag `sctp` puts in its INIT / INIT_ACK. */
export function localVerificationTagOf(sctp: SCTP) {
  return (sctp as unknown as SctpInternals).localVerificationTag;
}

/** Assert helper: chunk types carried by the packets a transport has sent. */
export function sentChunkTypes(sent: Buffer[]) {
  return sent.map((packet) => parsePacket(packet)[3][0].type);
}

/** Assert helper: [verification tag, first chunk type] of each sent packet. */
export function sentTagsAndTypes(sent: Buffer[]) {
  return sent.map((packet) => {
    const [, , tag, chunks] = parsePacket(packet);
    return [tag, chunks[0].type] as const;
  });
}

/** Chunk types an initiator of werift <= 0.26 ignores. */
export const LEGACY_INITIATOR_IGNORED = [InitChunk.type, CookieEchoChunk.type];

/** Chunk types carried by one serialized SCTP packet. */
const packetChunkTypes = (buf: Buffer) =>
  parsePacket(buf)[3].map((chunk) => chunk.type);

/**
 * Arrange: two SCTP endpoints with the given roles over memory transports.
 * `ignoredBySecond` drops the chunk types the first endpoint sends that the
 * second endpoint would ignore, emulating an older werift initiator.
 */
export const createSctpEndpointPair = ({
  roles,
  ignoredBySecond = [],
}: {
  roles: ["client" | "server", "client" | "server"];
  ignoredBySecond?: number[];
}) => {
  const transports = createMemoryTransportPair({
    dropClient: (buf) =>
      packetChunkTypes(buf).some((type) => ignoredBySecond.includes(type)),
  });
  const create = (role: "client" | "server", transport: MemoryTransport) =>
    role === "client" ? SCTP.client(transport) : SCTP.server(transport);
  const first = create(roles[0], transports.client);
  const second = create(roles[1], transports.server);
  const connected = Promise.all(
    [first, second].map((sctp) => sctp.stateChanged.connected.asPromise()),
  );
  const stop = async () => {
    await first.stop();
    await second.stop();
    transports.client.close();
    transports.server.close();
  };
  return { first, second, connected, stop };
};

/**
 * Arrange: two unstarted endpoints with the given roles whose packets in both
 * directions are recorded (`wire`) and dropped while `dropIf` says so. Fake
 * setTimeout / Date are installed first so T1 retransmissions can be advanced;
 * MemoryTransport's setImmediate stays real. Each endpoint's connection state
 * changes are recorded in `states`.
 */
export const createLossyEndpointPair = (
  roles: ["client" | "server", "client" | "server"],
) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const control = {
    dropIf: undefined as (() => boolean) | undefined,
    wire: [] as { tag: number; chunks: Chunk[] }[],
  };
  const record = (buf: Buffer) => {
    const [, , tag, chunks] = parsePacket(buf);
    control.wire.push({ tag, chunks });
    return control.dropIf?.() ?? false;
  };
  const transports = createMemoryTransportPair({
    dropClient: record,
    dropServer: record,
  });
  const create = (role: "client" | "server", transport: MemoryTransport) =>
    role === "client" ? SCTP.client(transport) : SCTP.server(transport);
  const endpoints = [
    create(roles[0], transports.client),
    create(roles[1], transports.server),
  ] as const;
  const states = endpoints.map((sctp) => {
    const history: string[] = [];
    for (const state of ["connecting", "connected", "closed"] as const) {
      sctp.stateChanged[state].subscribe(() => history.push(state));
    }
    return history;
  });
  const stop = async () => {
    vi.useRealTimers();
    for (const sctp of endpoints) await sctp.stop();
    transports.client.close();
    transports.server.close();
  };
  return { endpoints, states, control, stop };
};

/**
 * Unstarted client SCTP over a vi.fn transport that records sent packets.
 * `established` puts it in ESTABLISHED state so DATA/HEARTBEAT can flow.
 */
export type MockSctpTransport = Transport & {
  send: Mock<(buf: Buffer) => Promise<void>>;
  close: Mock<() => void>;
};

export const createMockSctp = ({ established = false } = {}) => {
  const transport: MockSctpTransport = {
    send: vi.fn(async (_buf: Buffer) => {}),
    close: vi.fn(),
  };
  const sctp = SCTP.client(transport, 5000);
  sctp.setRemotePort(5001);
  if (established) {
    (sctp as any).associationState = SCTP_STATE.ESTABLISHED;
  }
  return { sctp, transport };
};

/**
 * ESTABLISHED mock SCTP whose peer advertised a zero receive window and that
 * has no DATA in flight, so transmit() cannot send queued DATA.
 */
export const createZeroWindowMockSctp = () => {
  const mock = createMockSctp({ established: true });
  (mock.sctp as any).peerAdvertisedRwnd = 0;
  return mock;
};

/** Lets pending async sends / transmits settle. */
export const settle = async (times = 5) => {
  for (let i = 0; i < times; i++) {
    await waitImmediate();
  }
};

/** Chunks of every packet sent through the mock transport from call index `from`. */
export const sentChunks = (transport: MockSctpTransport, from = 0): Chunk[] =>
  transport.send.mock.calls
    .slice(from)
    .flatMap(([buf]) => parsePacket(buf as Buffer)[3]);

/** TSNs of DATA chunks sent from call index `from`. */
export const sentDataTsns = (transport: MockSctpTransport, from = 0) =>
  sentChunks(transport, from)
    .filter((c): c is DataChunk => c instanceof DataChunk)
    .map((c) => c.tsn);

/**
 * Blocks transport.send until `release()` so chunks marked for retransmission
 * stay pending while other events (SACK, T3) are processed.
 */
export const holdTransport = (transport: MockSctpTransport) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.send.mockImplementation(async () => {
    await gate;
  });
  return {
    release: () => {
      transport.send.mockImplementation(async () => {});
      release();
    },
  };
};

export const buildSack = (
  cumulativeTsn: number,
  gaps: [number, number][] = [],
  advertisedRwnd = 1024 * 1024,
) => {
  const sack = new SackChunk(0, undefined);
  sack.cumulativeTsn = cumulativeTsn;
  sack.gaps = gaps;
  sack.advertisedRwnd = advertisedRwnd;
  return sack;
};

export const receiveSack = (sctp: SCTP, sack: SackChunk): Promise<void> =>
  (sctp as any).receiveSackChunk(sack);

/** TSN preceding `tsn` with uint32 wrap-around. */
export const tsnBefore = (tsn: number) => (tsn + 0xffffffff) % 0x100000000;

export const sentQueueOf = (sctp: SCTP): DataChunk[] => [
  ...(sctp as any).sentQueue,
];

export const flightSizeOf = (sctp: SCTP): number => (sctp as any).flightSize;

/**
 * flightSize must equal the bookSize sum of in-flight chunks in sentQueue,
 * never be negative, and be 0 once sentQueue is empty.
 */
export const expectFlightSizeInvariant = (sctp: SCTP) => {
  const sentQueue = sentQueueOf(sctp);
  const inFlightBytes = sentQueue
    .filter((c) => c.inFlight)
    .reduce((sum, c) => sum + c.bookSize, 0);
  const flightSize = flightSizeOf(sctp);
  expect(flightSize).toBe(inFlightBytes);
  expect(flightSize).toBeGreaterThanOrEqual(0);
  if (sentQueue.length === 0) {
    expect(flightSize).toBe(0);
  }
};

/** Cancels timers and stops the SCTP so no open handle is left. */
export const disposeMockSctp = async (sctp: SCTP) => {
  // Unblock a transport held by holdTransport() so stop() can send ABORT.
  (sctp as any).transport.send.mockImplementation?.(async () => {});
  (sctp as any).timer3Cancel();
  (sctp as any).heartbeatCancel();
  await sctp.stop();
};

/**
 * Drop predicate for MemoryTransport that records every chunk sent and drops
 * packets by chunk kind: DATA while `dropData`, SACK while `dropSack`, the next
 * `dropForwardTsnCount` FORWARD-TSNs, and whatever `dropIf` (e.g. seeded random
 * loss) selects. Other packets pass. Dropped SACK packets are kept in
 * `heldSacks` so a test can deliver them late.
 */
export const createDataDropRecorder = () => {
  const recorder = {
    dropData: false,
    dropSack: false,
    /** Number of upcoming FORWARD-TSN packets to drop. */
    dropForwardTsnCount: 0,
    dropIf: undefined as ((chunks: Chunk[]) => boolean) | undefined,
    sentChunks: [] as Chunk[],
    heldSacks: [] as Buffer[],
    drop: (buf: Buffer) => {
      const [, , , chunks] = parsePacket(buf);
      recorder.sentChunks.push(...chunks);
      if (
        recorder.dropForwardTsnCount > 0 &&
        chunks.some((c) => c instanceof ForwardTsnChunk)
      ) {
        recorder.dropForwardTsnCount--;
        return true;
      }
      if (recorder.dropSack && chunks.some((c) => c instanceof SackChunk)) {
        recorder.heldSacks.push(buf);
        return true;
      }
      if (recorder.dropIf?.(chunks)) return true;
      return recorder.dropData && chunks.some((c) => c instanceof DataChunk);
    },
  };
  return recorder;
};

/**
 * Connected pair whose client packets (`recorder`) and server packets
 * (`serverRecorder`) can be dropped, with fake setTimeout / Date installed
 * after the handshake so T3-rtx and chunk lifetimes can be advanced.
 * MemoryTransport's setImmediate stays real.
 */
export const createLossyPrSctpPair = async () => {
  const recorder = createDataDropRecorder();
  const serverRecorder = createDataDropRecorder();
  const pair = await createConnectedSctpPair({
    dropClient: recorder.drop,
    dropServer: serverRecorder.drop,
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  const stop = async () => {
    vi.useRealTimers();
    await pair.stop();
  };

  return { ...pair, recorder, serverRecorder, stop };
};

/** Fake time well past the initial T3-rtx (SCTP_RTO_INITIAL = 3s). */
export const PAST_T3_MS = 3_100;

/** Act: advance fake time past T3-rtx and let the deliveries it triggers run. */
export const advancePastT3 = async () => {
  await vi.advanceTimersByTimeAsync(PAST_T3_MS);
  await flushImmediates();
};

/** DATA chunks a drop recorder saw, in send order (including dropped ones). */
export const recordedData = (recorder: { sentChunks: Chunk[] }) =>
  recorder.sentChunks.filter((c): c is DataChunk => c instanceof DataChunk);

/** FORWARD-TSN chunks a drop recorder saw, in send order (including dropped ones). */
export const recordedForwardTsns = (recorder: { sentChunks: Chunk[] }) =>
  recorder.sentChunks.filter(
    (c): c is ForwardTsnChunk => c instanceof ForwardTsnChunk,
  );

/** Lets MemoryTransport deliveries (setImmediate) and their handlers run. */
export const flushImmediates = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/**
 * Seeds of a property test, as in packages/webrtc/tests/pbt/shared/seeds.ts:
 * `<prefix>_SEEDS` seeds (default `defaults.seeds`) starting at `<prefix>_SEED`
 * (default 1). A failing seed is replayed with `<prefix>_SEED=<n> <prefix>_SEEDS=1`.
 */
export const propertySeeds = (prefix: string, defaults: { seeds: number }) => {
  const env = process.env;
  const count = Number(env[`${prefix}_SEEDS`] ?? defaults.seeds);
  const first = Number(env[`${prefix}_SEED`] ?? 1);
  return {
    seeds: [...Array(count)].map((_, index) => first + index),
    /** True when `<prefix>_SEED` picks the seeds (a replay of one seed). */
    seedSelected: env[`${prefix}_SEED`] !== undefined,
    replay: (seed: number | string) =>
      `${prefix}_SEED=${seed} ${prefix}_SEEDS=1`,
  };
};

/** Deterministic PRNG (mulberry32) so a failing random-loss seed can be replayed. */
export const createSeededRandom = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Sender bookkeeping that must hold at any time: flightSize equals the bytes of
 * the chunks counted in flight, and a counted chunk is neither gap-acked nor
 * waiting for retransmission. Returns a description of the first violation.
 */
export const findFlightSizeViolation = (sctp: SCTP) => {
  const sender = sctp as any;
  const sentQueue: DataChunk[] = [...sender.sentQueue];
  const inFlight = sentQueue.filter((c) => c.inFlight);
  const bytes = inFlight.reduce((acc, c) => acc + c.bookSize, 0);
  if (bytes !== sender.flightSize) {
    return `flightSize ${sender.flightSize} != in-flight bytes ${bytes}`;
  }
  const bad = inFlight.find((c) => c.acked || c.retransmit);
  if (bad) {
    return `tsn ${bad.tsn} counted in flight while acked=${bad.acked} retransmit=${bad.retransmit}`;
  }
  return undefined;
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
}: {
  lastReceivedTsn?: number;
  reconfigResponseSeq?: number;
} = {}) => {
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
