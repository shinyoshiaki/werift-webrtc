import { deepStrictEqual } from "assert";
import { readFileSync } from "fs";
import * as net from "node:net";
import { type Address, Event } from "../../common/src";
import { NodeStunServer, NodeTurnServer } from "../../ice-server/src";
import { Candidate } from "../src/candidate";
import { Connection } from "../src/ice";
import {
  CandidatePair,
  CandidatePairState,
  type IceOptions,
} from "../src/iceBase";
import { classes, methods } from "../src/stun/const";
import { Message } from "../src/stun/message";
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
