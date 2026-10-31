import * as dgram from "node:dgram";
import * as dns from "node:dns";
import * as net from "node:net";
import * as tls from "node:tls";
import { deepStrictEqual } from "assert";
import { readFileSync } from "fs";
import { type Address, Event, type Transport } from "../../common/src";
import { NodeStunServer, NodeTurnServer } from "../../ice-server/src";
import { Candidate } from "../src/candidate";
import {
  TransactionCancelled,
  TransactionFailed,
  TransactionTimeout,
} from "../src/exceptions";
import { Connection } from "../src/ice";
import {
  CandidatePair,
  CandidatePairState,
  type IceOptions,
} from "../src/iceBase";
import { classes, methods } from "../src/stun/const";
import { Message, parseMessage } from "../src/stun/message";
import { StunProtocol } from "../src/stun/protocol";
import { splitTurnTcpFrames } from "../src/turn/frame";
import type { StunOverTurnProtocol } from "../src/turn/protocol";
import type { Protocol, TransactionRequestOptions } from "../src/types/model";
import { getHostAddresses } from "../src/utils";

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

/**
 * Shared Arrange: an agent with UDP host sockets bound to `interfaceAddresses`
 * and no STUN server (only host candidates are gathered).
 */
export function createInterfaceBoundConnection(
  iceControlling: boolean,
  interfaceAddresses: IceOptions["interfaceAddresses"],
  options: Partial<IceOptions> = {},
) {
  return createTestConnection(iceControlling, {
    interfaceAddresses,
    ...options,
  });
}

/** UDP host candidates of `connection` with the address their socket is bound to. */
export function udpHostCandidatesWithBinding(connection: Connection) {
  return (connection as unknown as { protocols: Protocol[] }).protocols
    .filter(
      (protocol): protocol is StunProtocol =>
        protocol instanceof StunProtocol &&
        protocol.localCandidate?.type === "host" &&
        protocol.localCandidate.transport === "udp",
    )
    .map((protocol) => ({
      candidate: [protocol.localCandidate!.host, protocol.localCandidate!.port],
      bound: protocol.getExtraInfo(),
      localIp: protocol.localIp,
    }));
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
 * Shared Arrange: a full controlling agent `a` connected to an ICE-lite agent
 * `b` (which sends no checks of its own, so `a` selects a pair only from the
 * candidates it was given).
 */
export async function createConnectedLitePair() {
  const a = createTestConnection(true);
  const b = createTestConnection(false, { iceLite: true });
  await inviteAccept(a, b);
  a.remoteIsLite = true;
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
  /** Every STUN message sent, in order. */
  const sentMessages: Message[] = [];
  const transport: Transport = {
    type,
    closed: false,
    onData: () => {},
    address: { address: "127.0.0.1", port: 0, family: "IPv4" },
    send: async (data: Buffer, addr?: Address) => {
      if (addr) sentTo.push(addr);
      const message = parseMessage(data);
      if (message) sentMessages.push(message);
    },
    close: async () => {},
    ...metadata,
  };
  return { transport, sentTo, sentMessages };
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

/** Where a redirecting test TURN server sends clients; mutable. */
export interface TurnRedirectTarget {
  alternate?: Address;
  /** Sent after `alternate` as further ALTERNATE-SERVER attributes. */
  extraAlternates?: Address[];
  alternateDomain?: string;
}

/** 300 (Try Alternate) error response a TURN server would send for a request. */
export function createTurnTryAlternateResponse(
  request: Message,
  { alternate, extraAlternates = [], alternateDomain }: TurnRedirectTarget,
) {
  const response = new Message(
    request.messageMethod,
    classes.ERROR,
    request.transactionId,
  ).setAttribute("ERROR-CODE", [300, "Try Alternate"]);
  if (alternate) {
    response.setAttribute("ALTERNATE-SERVER", alternate);
    // Message#setAttribute keeps one value per name, so the repeated
    // attributes are appended as raw wire attributes (RFC 8489 §14.15).
    for (const extra of extraAlternates) {
      const packed = new Message(methods.ALLOCATE, classes.ERROR)
        .setAttribute("ALTERNATE-SERVER", extra)
        .bytes.subarray(24); // 20 byte header + 4 byte attribute header
      response.appendRawAttribute(0x8023, packed);
    }
  }
  if (alternateDomain) {
    response.setAttribute("ALTERNATE-DOMAIN", alternateDomain);
  }
  return response;
}

/**
 * TURN server on UDP 127.0.0.1 that answers every request with 300 (Try
 * Alternate) to `target`, read when each request arrives, and records the
 * requests it receives.
 */
export async function createUdpTurnRedirectServer(
  target: TurnRedirectTarget = {},
) {
  const requests: Message[] = [];
  const socket = dgram.createSocket("udp4");
  socket.on("message", (data, rinfo) => {
    const request = parseMessage(data);
    if (!request) return;
    requests.push(request);
    socket.send(
      createTurnTryAlternateResponse(request, target).bytes,
      rinfo.port,
      rinfo.address,
    );
  });
  await new Promise<void>((resolve) =>
    socket.bind(0, "127.0.0.1", () => resolve()),
  );
  const address: Address = ["127.0.0.1", socket.address().port];
  return {
    address,
    requests,
    target,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

/** Stream (TCP/TLS) counterpart of createUdpTurnRedirectServer. */
export async function createStreamTurnRedirectServer(
  target: TurnRedirectTarget = {},
  { tls: useTls = false }: { tls?: boolean } = {},
) {
  const server = await createStreamTurnServer({
    tls: useTls,
    reply: (request) => createTurnTryAlternateResponse(request, target),
  });
  const address: Address = ["127.0.0.1", server.port];
  return { ...server, address, target };
}

/**
 * Minimal TURN server over TCP or TLS on 127.0.0.1. It records the requests
 * it receives. With `respond`, it answers every request with `reply`,
 * createTurnSuccessResponse (no authentication) by default.
 */
export async function createStreamTurnServer({
  tls: useTls = false,
  respond = true,
  reply = createTurnSuccessResponse,
}: {
  tls?: boolean;
  respond?: boolean;
  reply?: (request: Message) => Message;
} = {}) {
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
          socket.write(reply(request).bytes);
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

/**
 * Stub dns.promises.lookup so every lookup waits until `release()`, then
 * answers `address` (a request whose lookup outlives its protocol).
 */
export function holdLookup(address: string) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(dns.promises, "lookup").mockImplementation((async () => {
    await released;
    return { address, family: net.isIP(address) };
  }) as unknown as typeof dns.promises.lookup);
  return { release, restore: () => spy.mockRestore() };
}

/** `process.getActiveResourcesInfo()` entries of `type` (e.g. `Timeout`). */
export function activeResourceCount(type: string) {
  return process.getActiveResourcesInfo().filter((t) => t === type).length;
}

/** Shared Arrange: a bound IPv4 STUN protocol on the loopback interface. */
export async function createLoopbackStunProtocol() {
  const protocol = new StunProtocol();
  await protocol.connectionMade(true);
  return protocol;
}

/**
 * Shared Arrange: a controlling agent with gathered host candidates whose
 * checks go to a remote candidate that never answers (the discard port), so
 * a check stays in flight; `transactions()` counts the STUN transactions
 * its sockets wait on.
 */
export async function createUnansweredCheckAgent() {
  const agent = createTestConnection(true);
  await agent.gatherCandidates();
  agent.remoteUsername = "remote";
  agent.remotePassword = "remote-password-0000000000";
  await agent.addRemoteCandidate(remoteHostCandidate(9));
  await agent.addRemoteCandidate(undefined);
  const transactions = () =>
    (
      agent as unknown as {
        protocols: { transactions?: Record<string, unknown> }[];
      }
    ).protocols.reduce(
      (sum, p) => sum + Object.keys(p.transactions ?? {}).length,
      0,
    );
  return { agent, transactions };
}

/** Shared Arrange: a UDP socket that receives and never answers (an unreachable TURN or STUN server). */
export async function createSilentUdpServer(host = "127.0.0.1") {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, host, () => resolve()));
  return {
    address: [host, socket.address().port] as Address,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

// --- late TURN relay candidates ---

/** Poll until `predicate` holds (rejects after `timeoutMs`). */
export async function waitUntil(predicate: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Shared Arrange: deliver `from`'s local candidates gathered so far to `to`,
 * and every later one as `from` trickles it.
 */
export function forwardLocalCandidates(from: Connection, to: Connection) {
  for (const candidate of from.localCandidates) {
    void to.addRemoteCandidate(Candidate.fromSdp(candidate.toSdp()));
  }
  from.onIceCandidate.subscribe((candidate) => {
    void to.addRemoteCandidate(Candidate.fromSdp(candidate.toSdp()));
  });
}

/**
 * Shared Arrange: `late` (controlling) gathers host candidates and a TURN
 * allocation that reaches the local server through a held proxy, so its relay
 * candidate arrives only on `proxy.release()`. `early` (controlled) has
 * finished gathering (relay-only by default) and both know each other's ICE
 * credentials. `gathering` is `late`'s pending gatherCandidates().
 */
export async function createLateRelaySetup({
  late: lateOptions = {},
  early: earlyOptions,
}: {
  late?: Partial<IceOptions>;
  early?: (
    server: Awaited<ReturnType<typeof createLocalTurnServer>>,
    late: Connection,
  ) => Partial<IceOptions>;
} = {}) {
  const server = await createLocalTurnServer(getHostAddresses(true, false)[0]!);
  const proxy = await createHeldUdpProxy(server.address!);
  const late = createTestConnection(true, {
    ...proxiedTurnOptions(proxy),
    forceTurn: false,
    ...lateOptions,
  });
  const early = createTestConnection(
    false,
    earlyOptions ? earlyOptions(server, late) : localTurnOptions(server),
  );
  await early.gatherCandidates();
  const gathering = late.gatherCandidates();
  exchangeIceCredentials(late, early);
  return {
    server,
    proxy,
    late,
    early,
    gathering,
    close: async () => {
      proxy.release();
      await Promise.allSettled([late.close(), early.close()]);
      proxy.close();
      await server.close();
    },
  };
}

/** Pairs of `connection`'s check list whose local candidate is a relay. */
export function relayPairs(connection: Connection) {
  return connection.checkList.filter(
    (pair) => pair.localCandidate.type === "relay",
  );
}

/** Check list results `connection` has queued for connect() (ICE_FAILED / ICE_COMPLETED). */
export function queuedCheckListResults(connection: Connection) {
  return (
    connection as unknown as {
      checkListState: { queue: Promise<number>[] };
    }
  ).checkListState.queue.length;
}

/** Shared Arrange: a filterStunResponse that answers only checks from `peer`'s relay candidates. */
export function answerOnlyRelayOf(peer: Connection) {
  return (_message: Message, addr: Address) =>
    peer.localCandidates.some(
      (candidate) =>
        candidate.type === "relay" &&
        candidate.host === addr[0] &&
        candidate.port === addr[1],
    );
}

/** Wire bytes of one STUN attribute (4 byte header, value padded to 4 bytes). */
export function stunAttributeBytes(type: number, value: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([
    header,
    value,
    Buffer.alloc((4 - (value.length % 4)) % 4),
  ]);
}

/** `message` bytes with `attribute` appended and the header length updated. */
export function appendStunAttributeBytes(message: Buffer, attribute: Buffer) {
  const bytes = Buffer.concat([message, attribute]);
  bytes.writeUInt16BE(bytes.length - 20, 2);
  return bytes;
}

/**
 * Wire bytes of `message` (typed and raw attributes as they are) followed by a
 * MESSAGE-INTEGRITY computed over all of them, so every attribute in `message`
 * is inside the signed range.
 */
export function signStunMessageBytes(message: Message, key: Buffer) {
  const body = message.bytes;
  const integrity = stunAttributeBytes(0x0008, message.messageIntegrity(key));
  return appendStunAttributeBytes(body, integrity);
}

/** Wire value of an ALTERNATE-SERVER attribute for `address`. */
export function alternateServerValue(address: Address) {
  return new Message(methods.ALLOCATE, classes.ERROR)
    .setAttribute("ALTERNATE-SERVER", address)
    .bytes.subarray(24);
}

// --- check / nomination cancellation ---

/** How ScriptedCheckProtocol answers one request: a response, an error code, or no answer until released. */
export type ScriptedReply = "success" | "hold" | 401 | 487;

/** One request ScriptedCheckProtocol received. */
export type ScriptedRequest = {
  message: Message;
  /** Destination of the request (the pair's remote address). */
  addr: Address;
  nominate: boolean;
  /** Settled (answered, failed, or cancelled by its signal). */
  done: boolean;
  /** Answer a held request now (success, or a failure without response). */
  release: (outcome: "success" | "failure") => void;
};

/**
 * Mock Protocol whose request() answers as `reply` scripts it. A held request
 * stays in flight until its signal aborts (as a real transaction cancels) or
 * until `release`; `honorSignal: false` models a result that arrives after
 * the generation ended (the signal is ignored).
 */
export class ScriptedCheckProtocol implements Protocol {
  type: string;
  localCandidate: Candidate;
  onRequestReceived = new Event<[Message, any, Buffer]>();
  onDataReceived = new Event<[Buffer]>();
  readonly requests: ScriptedRequest[] = [];
  readonly request: Protocol["request"];

  constructor(
    transport: "udp" | "tcp",
    reply: (request: { nominate: boolean; index: number }) => ScriptedReply,
    honorSignal = true,
  ) {
    this.type = transport;
    this.localCandidate = createConsentCandidate(
      "192.0.2.1",
      4000,
      "local",
      transport,
    );
    this.request = ((
      message: Message,
      addr: Address,
      _integrityKey?: Buffer,
      options?: number | TransactionRequestOptions,
    ) => {
      const signal = typeof options === "object" ? options.signal : undefined;
      const nominate = message.attributesKeys.includes("USE-CANDIDATE");
      const answer = reply({ nominate, index: this.requests.length });
      return new Promise((resolve, reject) => {
        const entry: ScriptedRequest = {
          message,
          addr,
          nominate,
          done: false,
          release: (outcome) => {
            if (entry.done) return;
            entry.done = true;
            if (outcome === "success") {
              resolve([new Message(methods.BINDING, classes.RESPONSE), addr]);
            } else {
              reject(new TransactionTimeout());
            }
          },
        };
        this.requests.push(entry);
        if (answer === "success") {
          entry.release("success");
          return;
        }
        if (answer === 401 || answer === 487) {
          entry.done = true;
          const response = new Message(methods.BINDING, classes.ERROR);
          response.setAttribute("ERROR-CODE", [answer, "scripted"]);
          reject(new TransactionFailed(response, addr));
          return;
        }
        if (!honorSignal || !signal) return;
        const cancel = () => {
          if (entry.done) return;
          entry.done = true;
          reject(new TransactionCancelled());
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    }) as Protocol["request"];
  }

  /** Requests still waiting for an answer (each one is a live STUN transaction). */
  pending() {
    return this.requests.filter((request) => !request.done).length;
  }

  async sendStun() {}
  async sendData() {}
  async connectionMade() {}
  async close() {}
}

/**
 * Shared Arrange: a controlling Connection whose remote credentials are set
 * and whose single protocol is a ScriptedCheckProtocol; `addPair()` puts a
 * WAITING pair on the checklist and `check(pair)` starts its check the way
 * the scheduler does (the handle is kept on the pair).
 */
export function createScriptedCheckHarness({
  transport = "udp",
  remoteIsLite = false,
  honorSignal = true,
  reply,
}: {
  transport?: "udp" | "tcp";
  remoteIsLite?: boolean;
  honorSignal?: boolean;
  reply: (request: { nominate: boolean; index: number }) => ScriptedReply;
}) {
  const protocol = new ScriptedCheckProtocol(transport, reply, honorSignal);
  const connection = new Connection(true);
  connection.remoteIsLite = remoteIsLite;
  const setRemoteCredentials = () => {
    connection.remoteUsername = "remote";
    connection.remotePassword = "remote-password-0000000000";
  };
  setRemoteCredentials();
  let port = 5000;
  const addPair = () => {
    const remoteCandidate = createConsentCandidate(
      "192.0.2.2",
      port++,
      "remote",
      transport,
    );
    if (transport === "tcp") remoteCandidate.tcptype = "passive";
    const pair = new CandidatePair(protocol, remoteCandidate, true);
    pair.updateState(CandidatePairState.WAITING);
    connection.checkList.push(pair);
    return pair;
  };
  const check = (pair: CandidatePair) => {
    pair.handle = connection.checkStart(pair);
    return pair.handle;
  };
  const nominating = () =>
    (connection as unknown as { nominating: boolean }).nominating;
  return {
    connection,
    protocol,
    addPair,
    check,
    nominating,
    setRemoteCredentials,
  };
}

// --- regular nomination ---

/**
 * Shared Arrange for regular nomination: a controlling full agent whose local
 * gathering finished, with one ScriptedCheckProtocol. Ordinary checks stay in
 * flight until `succeed` / `fail`; USE-CANDIDATE checks are answered by
 * `nominationReply` (success by default). Remote candidates are trickled with
 * `addRemote(priority)` (a higher priority makes a higher-priority pair), the
 * way signaling delivers them, so the agent sees each pair being added.
 */
export function createNominationHarness({
  nominationDelayMs,
  remoteIsLite = false,
  nominationReply = () => "success",
}: {
  nominationDelayMs?: number;
  remoteIsLite?: boolean;
  nominationReply?: (nominationIndex: number) => ScriptedReply;
} = {}) {
  let nominationCount = 0;
  const protocol = new ScriptedCheckProtocol("udp", ({ nominate }) =>
    nominate ? nominationReply(nominationCount++) : "hold",
  );
  const connection = new Connection(true, { nominationDelayMs });
  connection.remoteIsLite = remoteIsLite;
  connection.remoteUsername = "remote";
  connection.remotePassword = "remote-password-0000000000";
  connection.localCandidatesEnd = true;
  (connection as unknown as { protocols: Protocol[] }).protocols.push(protocol);

  let port = 5000;
  const remoteCandidate = (priority: number) =>
    new Candidate(
      `remote${port}`,
      1,
      "udp",
      priority,
      "192.0.2.2",
      port++,
      "host",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  /** Trickle a remote candidate; returns the live pair it formed. */
  const addRemote = async (priority: number) => {
    const candidate = remoteCandidate(priority);
    await connection.addRemoteCandidate(candidate);
    return connection.checkList.find(
      (pair) => pair.remoteCandidate === candidate,
    )!;
  };
  /** Start the ordinary check of `pair` as the scheduler does. */
  const check = (pair: CandidatePair) => {
    pair.handle = connection.checkStart(pair);
    return pair.handle;
  };
  const pendingCheck = (pair: CandidatePair) =>
    protocol.requests.find(
      (request) =>
        !request.nominate &&
        !request.done &&
        request.addr[0] === pair.remoteAddr[0] &&
        request.addr[1] === pair.remoteAddr[1],
    );
  /** Answer the ordinary check of `pair` in flight. */
  const succeed = async (pair: CandidatePair) => {
    pendingCheck(pair)!.release("success");
    await vi.advanceTimersByTimeAsync(0);
  };
  /** USE-CANDIDATE checks sent so far, with the port they were sent to. */
  const nominations = () =>
    protocol.requests.filter((request) => request.nominate);
  const ordinaryChecks = () =>
    protocol.requests.filter((request) => !request.nominate);

  // Provisional generation (an ICE restart signalled in a pranswer).
  const stageProvisional = () => {
    connection.stageLocalCredentials("provA", "provisional-password-a-000");
    connection.setProvisionalRemoteParams({
      usernameFragment: "provB",
      password: "provisional-password-b-000",
    });
    connection.startProvisionalChecks();
  };
  /** Trickle a provisional remote candidate; its check starts at once. */
  const addProvisionalRemote = async (priority: number) => {
    const candidate = remoteCandidate(priority);
    await connection.addProvisionalRemoteCandidate(candidate);
    return provisionalGeneration(connection)!.pairs.find(
      (pair) => pair.remoteCandidate === candidate,
    )!;
  };
  /** Replacement pranswer: new remote credentials for the provisional checklist. */
  const replaceProvisionalRemote = () =>
    connection.setProvisionalRemoteParams({
      usernameFragment: "provC",
      password: "provisional-password-c-000",
    });

  return {
    connection,
    protocol,
    addRemote,
    check,
    succeed,
    nominations,
    ordinaryChecks,
    stageProvisional,
    addProvisionalRemote,
    replaceProvisionalRemote,
  };
}
