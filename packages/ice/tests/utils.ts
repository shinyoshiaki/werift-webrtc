import { deepStrictEqual } from "assert";
import { readFileSync } from "fs";
import * as dgram from "node:dgram";
import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";
import { type Address, Event, type Transport } from "../../common/src";
import { NodeStunServer, NodeTurnServer } from "../../ice-server/src";
import { Candidate } from "../src/candidate";
import { Connection } from "../src/ice";
import {
  CandidatePair,
  CandidatePairState,
  type IceOptions,
} from "../src/iceBase";
import { classes, methods } from "../src/stun/const";
import { Message, parseMessage } from "../src/stun/message";
import { splitTurnTcpFrames } from "../src/turn/frame";
import { getHostAddresses } from "../src/utils";
import type { StunOverTurnProtocol } from "../src/turn/protocol";
import type { Protocol, TransactionRequestOptions } from "../src/types/model";

export const TURN_TEST_USERNAME = "turn-user";
export const TURN_TEST_PASSWORD = "turn-password";

/** Arrange helper: accepts TCP but never completes a TLS handshake. */
export async function createHangingTlsServer() {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;

  return {
    address: [address.address, address.port] as [string, number],
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export type ConsentOutcome = "success" | "timeout";

export type ConsentHarness = {
  connection: Connection;
  nominated: CandidatePair;
  protocol: ConsentMockProtocol;
  request: ConsentMockProtocol["request"];
  requestTimes: number[];
  sentMessages: Message[];
};
/** Shared Arrange helper: host candidate for consent harnesses. */
export function createConsentCandidate(
  host: string,
  port: number,
  ufrag?: string,
  transport = "udp",
): Candidate {
  return new Candidate(
    "foundation",
    1,
    transport,
    2_130_706_431,
    host,
    port,
    "host",
    undefined,
    undefined,
    transport === "tcp" ? "active" : undefined,
    0,
    ufrag,
  );
}

/**
 * Mock Protocol used by consent freshness tests.
 * Counts request() and sendStun() so UDP / TCP / TURN paths can share Arrange.
 */
export class ConsentMockProtocol implements Protocol {
  type: string;
  localCandidate: Candidate;
  onRequestReceived = new Event<[Message, any, Buffer]>();
  onDataReceived = new Event<[Buffer]>();
  sentMessages: Message[] = [];
  sendStunCount = 0;
  requestTimes: number[] = [];
  /** Transaction options of each request(), normalized to the object form. */
  requestOptions: TransactionRequestOptions[] = [];
  readonly request: Protocol["request"];

  constructor(
    options: {
      type?: string;
      localCandidate?: Candidate;
      outcomes?: ConsentOutcome[];
      responseDelayMilliseconds?: number;
      /** When set, request() delegates to a real-style single-shot sendStun path. */
      useSendStunPath?: boolean;
    } = {},
  ) {
    this.type = options.type ?? "udp";
    this.localCandidate =
      options.localCandidate ??
      createConsentCandidate("192.0.2.1", 4000, "local");
    const outcomes = options.outcomes ?? [];
    const responseDelayMilliseconds = options.responseDelayMilliseconds ?? 0;

    this.request = (async (
      message: Message,
      _addr,
      _integrityKey?,
      retransmissionsOrOptions?: number | TransactionRequestOptions,
      onRequestSent?: (attempt: number) => void,
    ) => {
      this.requestTimes.push(Date.now());
      this.sentMessages.push(message);
      this.requestOptions.push(
        typeof retransmissionsOrOptions === "object" &&
          retransmissionsOrOptions !== null
          ? retransmissionsOrOptions
          : { retransmissions: retransmissionsOrOptions, onRequestSent },
      );

      const retransmissions =
        typeof retransmissionsOrOptions === "object" &&
        retransmissionsOrOptions !== null
          ? (retransmissionsOrOptions.retransmissions ?? 0)
          : (retransmissionsOrOptions ?? 0);
      const responseTimeout =
        typeof retransmissionsOrOptions === "object" &&
        retransmissionsOrOptions !== null
          ? (retransmissionsOrOptions.responseTimeout ?? 50)
          : 50;
      const signal =
        typeof retransmissionsOrOptions === "object" &&
        retransmissionsOrOptions !== null
          ? retransmissionsOrOptions.signal
          : undefined;
      const sentCb =
        typeof retransmissionsOrOptions === "object" &&
        retransmissionsOrOptions !== null
          ? retransmissionsOrOptions.onRequestSent
          : onRequestSent;

      // One initial send + retransmissions (consent uses 0).
      const maxSends = 1 + retransmissions;
      for (let attempt = 0; attempt < maxSends; attempt++) {
        sentCb?.(attempt);
        this.sendStunCount++;
        if (attempt < maxSends - 1) {
          await delay(responseTimeout * 2 ** attempt, signal);
        }
      }

      if (responseDelayMilliseconds > 0) {
        await delay(responseDelayMilliseconds, signal);
      }

      const outcome = outcomes.shift() ?? "success";
      if (outcome === "timeout") {
        throw new Error("simulated STUN timeout");
      }
      return [
        new Message(methods.BINDING, classes.RESPONSE),
        ["192.0.2.2", 5000] as const,
      ];
    }) as Protocol["request"];
  }

  async sendStun(message: Message) {
    this.sendStunCount++;
    this.sentMessages.push(message);
  }
  async sendData() {}
  async connectionMade() {}
  async close() {}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Arrange: Connection with a nominated pair and scripted consent outcomes.
 * Starts queryConsent() so tests only advance timers.
 */
export function createConsentHarness(
  outcomes: ConsentOutcome[],
  options: {
    iceControlling?: boolean;
    remoteIsLite?: boolean;
    responseDelayMilliseconds?: number;
    protocolType?: string;
    transport?: string;
  } = {},
): ConsentHarness {
  const iceControlling = options.iceControlling ?? true;
  const protocol = new ConsentMockProtocol({
    type: options.protocolType ?? "udp",
    localCandidate: createConsentCandidate(
      "192.0.2.1",
      4000,
      "local",
      options.transport ?? "udp",
    ),
    outcomes: [...outcomes],
    responseDelayMilliseconds: options.responseDelayMilliseconds,
  });
  const remoteCandidate = createConsentCandidate(
    "192.0.2.2",
    5000,
    "remote",
    options.transport ?? "udp",
  );
  const nominated = new CandidatePair(
    protocol,
    remoteCandidate,
    iceControlling,
  );
  nominated.nominated = true;

  const connection = new Connection(iceControlling);
  connection.remoteUsername = "remote";
  connection.remotePassword = "remote-password";
  connection.remoteIsLite = options.remoteIsLite ?? true;
  connection.nominated = nominated;
  connection.state = "connected";
  // Private method is reachable at runtime for consent lifecycle tests.
  (connection as any).queryConsent();

  return {
    connection,
    nominated,
    protocol,
    request: protocol.request,
    requestTimes: protocol.requestTimes,
    sentMessages: protocol.sentMessages,
  };
}

export function readMessage(name: string) {
  let data!: Buffer;

  try {
    data = readFileSync("./tests/data/" + name);
  } catch (error) {
    data = readFileSync("./packages/ice/tests/data/" + name);
  }

  return data;
}

function readTlsAsset(name: string) {
  try {
    return readFileSync("./packages/dtls/assets/" + name);
  } catch (error) {
    return readFileSync("./../dtls/assets/" + name);
  }
}

export function getLocalTurnServerTlsOptions() {
  return {
    cert: readTlsAsset("cert.pem"),
    key: readTlsAsset("key.pem"),
  };
}

export function getLocalTurnClientTlsOptions() {
  return {
    rejectUnauthorized: false,
  };
}

export async function inviteAccept(a: Connection, b: Connection) {
  // # invite
  await a.gatherCandidates();
  b.remoteCandidates = a.localCandidates;
  b.remoteUsername = a.localUsername;
  b.remotePassword = a.localPassword;

  // # accept
  await b.gatherCandidates();
  a.remoteCandidates = b.localCandidates;
  a.remoteUsername = b.localUsername;
  a.remotePassword = b.localPassword;
}

export function assertCandidateTypes(conn: Connection, expected: string[]) {
  const types = conn.localCandidates.map((v) => v.type);
  deepStrictEqual(new Set(types), new Set(expected));
}

export function createTestConnection(
  iceControlling: boolean,
  options: Partial<IceOptions> = {},
) {
  const connection = new Connection(iceControlling, options);
  connection.stunServer = options.stunServer;
  return connection;
}

export async function createLocalStunServer(host: string) {
  const server = new NodeStunServer({
    host,
    port: 0,
    software: "werift-ice-server/test",
  });
  await server.listen();
  return server;
}

export async function createLocalTurnServer(
  host: string,
  options: {
    tls?: boolean;
  } = {},
) {
  const server = new NodeTurnServer({
    host,
    port: 0,
    relayAddress: host,
    relayBindAddress: host,
    credentials: {
      [TURN_TEST_USERNAME]: TURN_TEST_PASSWORD,
    },
    realm: "werift.local",
    software: "werift-ice-server/test",
    tls: options.tls ? getLocalTurnServerTlsOptions() : undefined,
  });
  await server.listen();
  return server;
}

/** Shared Arrange helper: two host-only connections with a nominated pair. */
export async function createConnectedPair() {
  const a = createTestConnection(true);
  const b = createTestConnection(false);
  await inviteAccept(a, b);
  await Promise.all([a.connect(), b.connect()]);
  return { a, b };
}

/**
 * Arrange: stage a new local generation on both sides and feed
 * each side the other's staged credentials and candidates, as a pranswer
 * carrying an ICE restart would.
 */
export async function stageProvisionalGeneration(a: Connection, b: Connection) {
  const credentials = {
    a: { usernameFragment: "provA", password: "provisional-password-a-000" },
    b: { usernameFragment: "provB", password: "provisional-password-b-000" },
  };
  a.stageLocalCredentials(
    credentials.a.usernameFragment,
    credentials.a.password,
  );
  b.stageLocalCredentials(
    credentials.b.usernameFragment,
    credentials.b.password,
  );
  a.setProvisionalRemoteParams(credentials.b);
  b.setProvisionalRemoteParams(credentials.a);
  for (const [local, remote] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const candidate of remote.localCandidates) {
      await local.addProvisionalRemoteCandidate(
        Candidate.fromSdp(candidate.toSdp()),
      );
    }
    await local.addProvisionalRemoteCandidate(undefined);
  }
  return credentials;
}

/** Wait until the provisional generation of `connection` has a nominated pair. */
export async function waitProvisionalNominated(
  connection: Connection,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!connection.provisionalNominated) {
    if (Date.now() > deadline)
      throw new Error("provisional generation was not nominated");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return connection.provisionalNominated;
}

/** Data sent on the selected pair from `from` arrives at `to`. */
export async function expectDataFlows(
  from: Connection,
  to: Connection,
  text: string,
) {
  const received = to.onData.watch((data) => data.toString() === text, 2000);
  await from.send(Buffer.from(text));
  await received;
}

/** Arrange: controlling Connection with one TCP mock protocol and no pairs yet. */
export function createTcpCheckHarness() {
  const protocol = new ConsentMockProtocol({
    type: "tcp",
    localCandidate: createConsentCandidate("192.0.2.1", 9, "local", "tcp"),
  });
  const connection = new Connection(true);
  connection.remoteUsername = "remote";
  connection.remotePassword = "remote-password";
  const remoteAddr: Address = ["192.0.2.2", 5000];
  return { connection, protocol, remoteAddr };
}

/** Arrange: TCP pair (local active -> remote passive) added to the check list. */
export function addTcpPair(harness: ReturnType<typeof createTcpCheckHarness>) {
  const remoteCandidate = createConsentCandidate(
    harness.remoteAddr[0],
    harness.remoteAddr[1],
    "remote",
    "tcp",
  );
  remoteCandidate.tcptype = "passive";
  const pair = new CandidatePair(
    harness.protocol,
    remoteCandidate,
    harness.connection.iceControlling,
  );
  pair.updateState(CandidatePairState.WAITING);
  harness.connection.checkList.push(pair);
  return pair;
}

/** Arrange: incoming ICE connectivity check sent by the controlled peer. */
export function createIncomingCheck(
  connection: Connection,
  options: { useCandidate?: boolean } = {},
) {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request
    .setAttribute(
      "USERNAME",
      `${connection.localUsername}:${connection.remoteUsername}`,
    )
    .setAttribute("PRIORITY", 1_000)
    .setAttribute("ICE-CONTROLLED", 1n);
  if (options.useCandidate) request.setAttribute("USE-CANDIDATE", null);
  return request;
}

/** Arrange: two agents (a = controlling) gathering TCP host candidates only. */
export function createTcpOnlyConnections() {
  const options: Partial<IceOptions> = {
    useTcp: true,
    useIpv6: false,
    stunServer: undefined,
  };
  return {
    a: createTestConnection(true, options),
    b: createTestConnection(false, options),
  };
}

/** Arrange: offer/answer exchange that only exposes TCP candidates. */
export async function exchangeTcpOnlyCandidates(a: Connection, b: Connection) {
  await a.gatherCandidates();
  b.remoteCandidates = a.localCandidates.filter(
    (candidate) => candidate.transport === "tcp",
  );
  b.remoteUsername = a.localUsername;
  b.remotePassword = a.localPassword;
  await b.gatherCandidates();
  a.remoteCandidates = b.localCandidates.filter(
    (candidate) => candidate.transport === "tcp",
  );
  a.remoteUsername = b.localUsername;
  a.remotePassword = b.localPassword;
}

/** Arrange: TCP-only agents that completed ICE with each other. */
export async function connectTcpOnly() {
  const { a, b } = createTcpOnlyConnections();
  await exchangeTcpOnlyCandidates(a, b);
  await Promise.all([a.connect(), b.connect()]);
  return { a, b };
}

/** Socket of the TCP connection behind `connection.nominated`. */
export function getSelectedTcpSocket(connection: Connection) {
  const pair = connection.nominated;
  if (!pair) return;
  const sockets: Map<string, { socket: net.Socket }> | undefined = (
    pair.protocol as any
  ).sockets;
  return sockets?.get(`${pair.remoteAddr[0]}:${pair.remoteAddr[1]}`)?.socket;
}

/** Arrange: plain TCP server that records accepted sockets. */
export async function createRecordingTcpServer(host = "127.0.0.1") {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address() as net.AddressInfo;
  return {
    address: [host, address.port] as Address,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Arrange: a loopback TCP port with nothing listening on it. */
export async function getClosedTcpPort(host = "127.0.0.1") {
  const server = await createRecordingTcpServer(host);
  await server.close();
  return server.address;
}

/**
 * Arrange: replace the mDNS lookup of `connection` with one the test
 * resolves, so a `.local` candidate can stay resolving while other
 * operations (end-of-candidates, restart, replacement) run.
 */
export function stubMdnsLookup(connection: Connection) {
  const pending: ((address: string) => void)[] = [];
  const stub = {
    lookup: () =>
      new Promise<string>((resolve) => {
        pending.push(resolve);
      }),
    close: () => undefined,
  };
  (connection as unknown as { lookup?: typeof stub }).lookup = stub;
  return {
    get pending() {
      return pending.length;
    },
    resolveAll: (address = "127.0.0.1") => {
      for (const resolve of pending.splice(0)) resolve(address);
    },
  };
}

/** A remote host candidate at `host:port` (`host` may be an mDNS name). */
export function remoteHostCandidate(port: number, host = "127.0.0.1") {
  return Candidate.fromSdp(
    `candidate${port} 1 udp 2130706431 ${host} ${port} typ host`,
  );
}

/** Test-only observation of the provisional generation of `connection`. */
export function provisionalGeneration(connection: Connection) {
  return (
    connection as unknown as {
      provisional?: {
        remoteCandidates: Candidate[];
        remoteCandidatesEnd: boolean;
        pairs: CandidatePair[];
      };
    }
  ).provisional;
}

/**
 * Arrange: hold the response of the next check request sent for `pair`;
 * `release` answers it with a success response from the pair's address.
 */
export function holdNextCheckResponse(pair: CandidatePair) {
  const protocol = pair.protocol;
  const original = protocol.request.bind(protocol);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  protocol.request = (async () => {
    protocol.request = original;
    await held;
    return [new Message(methods.BINDING, classes.RESPONSE), pair.remoteAddr];
  }) as typeof protocol.request;
  return { release };
}

/** Test-only access to start one provisional check of `pair` directly. */
export function checkProvisionalPair(
  connection: Connection,
  pair: CandidatePair,
) {
  const internal = connection as unknown as {
    provisional?: { started: boolean };
    checkProvisional: (
      generation: unknown,
      pair: CandidatePair,
    ) => Promise<void>;
  };
  const generation = internal.provisional!;
  generation.started = true;
  return internal.checkProvisional(generation, pair);
}

/**
 * Transport stub that records every destination address it is asked to send
 * to, without touching the network. `metadata` is what the transport reports
 * about itself; leave it empty to model a custom transport that reports
 * nothing.
 */
export function createRecordingTransport(
  type: "udp" | "tcp",
  metadata: Pick<Transport, "addressFamily" | "remoteAddress"> = {},
) {
  const sentTo: Address[] = [];
  const transport: Transport = {
    type,
    closed: false,
    onData: () => {},
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    send: async (_data: Buffer, addr?: Address) => {
      if (addr) sentTo.push(addr);
    },
    close: async () => {},
    ...metadata,
  };
  return { transport, sentTo };
}

/**
 * Replace a real transport's send with a recorder, so tests can see where a
 * built-in transport would send without putting packets on the network.
 */
export function recordSends(transport: Transport) {
  const sentTo: Address[] = [];
  vi.spyOn(transport, "send").mockImplementation(
    async (_data: Buffer, addr?: Address) => {
      if (addr) sentTo.push(addr);
    },
  );
  return sentTo;
}

/**
 * Stub dns.promises.lookup. `answer` picks the address for each call from the
 * requested family and the call index; the requested families are recorded.
 */
export function stubLookup(
  answer: (family: number | undefined, call: number) => string,
) {
  const families: (number | undefined)[] = [];
  const spy = vi.spyOn(dns.promises, "lookup").mockImplementation((async (
    _host: string,
    options?: { family?: number },
  ) => {
    const address = answer(options?.family, families.length);
    families.push(options?.family);
    return { address, family: net.isIP(address) };
  }) as unknown as typeof dns.promises.lookup);
  return { families, restore: () => spy.mockRestore() };
}

/**
 * Stub dns.promises.lookup for a dual-stack host: family 4 answers the IPv4
 * address, family 6 and family 0 (no preference) answer the IPv6 address,
 * like a resolver that returns AAAA first. Records the requested families.
 */
export function stubDualStackLookup(ipv4: string, ipv6: string) {
  return stubLookup((family) => (family === 4 ? ipv4 : ipv6));
}

/**
 * Stub dns.promises.lookup for a host whose answer changes: the first call
 * answers `first`, every later call answers `later` (DNS rotation).
 */
export function stubRotatingLookup(first: string, later: string) {
  return stubLookup((_family, call) => (call === 0 ? first : later));
}

/** Success response a TURN server would send for a request. */
export function createTurnSuccessResponse(request: Message) {
  const response = new Message(
    request.messageMethod,
    classes.RESPONSE,
    request.transactionId,
  );
  if (request.messageMethod === methods.ALLOCATE) {
    response
      .setAttribute("XOR-RELAYED-ADDRESS", ["198.51.100.1", 50000])
      .setAttribute("XOR-MAPPED-ADDRESS", ["198.51.100.2", 40000])
      .setAttribute("LIFETIME", 600);
  }
  return response;
}

/**
 * Minimal TURN server over TCP or TLS on 127.0.0.1. It records the requests
 * it receives. With `respond`, it answers every request with
 * createTurnSuccessResponse (no authentication).
 */
export async function createStreamTurnServer({
  tls: useTls = false,
  respond = true,
}: { tls?: boolean; respond?: boolean } = {}) {
  const requests: Message[] = [];
  const sockets = new Set<net.Socket>();
  const onConnection = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      const { frames, rest } = splitTurnTcpFrames(
        Buffer.concat([buffer, data]),
      );
      buffer = rest;
      for (const frame of frames) {
        const request = parseMessage(frame);
        if (!request) continue;
        requests.push(request);
        if (respond) {
          socket.write(createTurnSuccessResponse(request).bytes);
        }
      }
    });
    socket.on("error", () => {});
  };
  const server = useTls
    ? tls.createServer(getLocalTurnServerTlsOptions(), onConnection)
    : net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Whether a UDP socket can bind the IPv6 loopback address on this host. */
export async function canBindIpv6Loopback() {
  const socket = dgram.createSocket("udp6");
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "::1", () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      socket.close();
    } catch {}
  }
}

/** Relay-only TURN options of a local test server for `createTestConnection`. */
export function localTurnOptions(
  server: Awaited<ReturnType<typeof createLocalTurnServer>>,
) {
  return {
    stunServer: undefined,
    turnServer: server.address!,
    turnUsername: TURN_TEST_USERNAME,
    turnPassword: TURN_TEST_PASSWORD,
    forceTurn: true,
  };
}

/** TURN allocations (relay protocols) a connection currently holds. */
export function turnAllocations(connection: Connection) {
  return (
    (connection as unknown as { protocols: unknown[] })
      .protocols as StunOverTurnProtocol[]
  ).filter((protocol) => protocol.localCandidate?.type === "relay");
}

export function localRelayCandidates(connection: Connection) {
  return connection.localCandidates.filter(
    (candidate) => candidate.type === "relay",
  );
}

/**
 * Arrange: a UDP proxy in front of `target` (a local TURN server) that holds
 * client-to-server datagrams until `release()`, so a gather's TURN
 * allocation (or STUN query) completes only when the test lets it.
 */
export async function createHeldUdpProxy(target: Address) {
  const host = target[0];
  const family = net.isIPv4(host) ? "udp4" : "udp6";
  const front = dgram.createSocket(family);
  await new Promise<void>((resolve) => front.bind(0, host, resolve));
  const upstream = new Map<string, dgram.Socket>();
  const queued: (() => void)[] = [];
  let held = true;
  front.on("message", (data, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let socket = upstream.get(key);
    if (!socket) {
      socket = dgram.createSocket(family);
      socket.bind(0, host);
      socket.on("message", (reply) => {
        front.send(reply, rinfo.port, rinfo.address);
      });
      upstream.set(key, socket);
    }
    const forward = () => socket!.send(data, target[1], target[0]);
    if (held) queued.push(forward);
    else forward();
  });
  return {
    address: [host, front.address().port] as Address,
    release() {
      held = false;
      for (const forward of queued.splice(0)) forward();
    },
    /** Queue the following datagrams again until the next `release()`. */
    hold() {
      held = true;
    },
    close() {
      for (const socket of upstream.values()) socket.close();
      front.close();
    },
  };
}

/**
 * Shared Arrange: give each connection the other's current ICE credentials
 * (as the descriptions of a negotiation would).
 */
export function exchangeIceCredentials(a: Connection, b: Connection) {
  a.remoteUsername = b.localUsername;
  a.remotePassword = b.localPassword;
  b.remoteUsername = a.localUsername;
  b.remotePassword = a.localPassword;
}

/** Shared Arrange: deliver `from`'s local candidates (and optionally end-of-candidates) to `to`. */
export async function deliverLocalCandidates(
  from: Connection,
  to: Connection,
  { endOfCandidates }: { endOfCandidates: boolean },
) {
  for (const candidate of from.localCandidates) {
    await to.addRemoteCandidate(Candidate.fromSdp(candidate.toSdp()));
  }
  if (endOfCandidates) await to.addRemoteCandidate(undefined);
}

/**
 * Shared Arrange: two relay-only connections (b reaches the TURN server
 * through `proxy`, released) with a nominated relay pair.
 */
export async function createConnectedRelayOnlyPair() {
  const server = await createLocalTurnServer(getHostAddresses(true, false)[0]!);
  const proxy = await createHeldUdpProxy(server.address!);
  proxy.release();
  const a = createTestConnection(true, localTurnOptions(server));
  const b = createTestConnection(false, proxiedTurnOptions(proxy));
  await Promise.all([a.gatherCandidates(), b.gatherCandidates()]);
  exchangeIceCredentials(a, b);
  await deliverLocalCandidates(a, b, { endOfCandidates: true });
  await deliverLocalCandidates(b, a, { endOfCandidates: true });
  await Promise.all([a.connect(), b.connect()]);
  return {
    a,
    b,
    proxy,
    close: async () => {
      await Promise.allSettled([a.close(), b.close()]);
      proxy.close();
      await server.close();
    },
  };
}

/** Relay-only TURN options that reach `server` through `proxy`. */
export function proxiedTurnOptions(proxy: { address: Address }) {
  return {
    stunServer: undefined,
    turnServer: proxy.address,
    turnUsername: TURN_TEST_USERNAME,
    turnPassword: TURN_TEST_PASSWORD,
    forceTurn: true,
  };
}

/**
 * Act helper: send one connectivity check from `from`'s selected pair to its
 * peer, addressed to `remoteUfrag` and signed with `remotePassword`, claiming
 * the controlled role with the highest tie-breaker (a role conflict for a
 * controlled peer). Resolves with the ERROR-CODE the verified response
 * carries; a response the password cannot verify is dropped (timeout).
 */
export async function sendRoleConflictCheck(
  from: Connection,
  {
    remoteUfrag,
    localUfrag,
    remotePassword,
  }: { remoteUfrag: string; localUfrag: string; remotePassword: string },
) {
  const pair = from.nominated!;
  const request = new Message(methods.BINDING, classes.REQUEST)
    .setAttribute("USERNAME", `${remoteUfrag}:${localUfrag}`)
    .setAttribute("PRIORITY", 1)
    .setAttribute("ICE-CONTROLLED", 2n ** 64n - 1n);
  try {
    await pair.protocol.request(
      request,
      pair.remoteAddr,
      Buffer.from(remotePassword, "utf8"),
      0,
    );
    return undefined;
  } catch (error) {
    return (error as { response?: Message }).response?.getAttributeValue(
      "ERROR-CODE",
    )?.[0] as number | undefined;
  }
}

/** Requests `connection` sends from now on, over every protocol it holds. */
export function recordCheckRequests(connection: Connection) {
  let count = 0;
  for (const protocol of (connection as unknown as { protocols: Protocol[] })
    .protocols) {
    const original = protocol.request.bind(protocol);
    protocol.request = ((...args: Parameters<typeof original>) => {
      count++;
      return original(...args);
    }) as typeof protocol.request;
  }
  return { count: () => count };
}

// --- spec coverage: ice ---

/**
 * Arrange: run `atSelection` right after `connection` selects its first pair
 * (in the microtask that follows the successful check that nominated it),
 * before `connect()` resolves and before any consent request is sent. The
 * returned promise settles with what `atSelection` returned.
 */
export function atFirstSelection<T>(
  connection: Connection,
  atSelection: (pair: CandidatePair) => T,
) {
  let selected: CandidatePair | undefined;
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  Object.defineProperty(connection, "nominated", {
    configurable: true,
    enumerable: true,
    get: () => selected,
    set: (pair: CandidatePair | undefined) => {
      const first = !selected && !!pair;
      selected = pair;
      if (!first) return;
      queueMicrotask(() => {
        try {
          resolve(atSelection(pair!));
        } catch (error) {
          reject(error);
        }
      });
    },
  });
  return result;
}
