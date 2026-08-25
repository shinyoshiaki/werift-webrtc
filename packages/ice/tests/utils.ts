import { deepStrictEqual } from "assert";
import { readFileSync } from "fs";
import { type Address, Event } from "../../common/src";
import { NodeStunServer, NodeTurnServer } from "../../ice-server/src";
import { Candidate } from "../src/candidate";
import { Connection } from "../src/ice";
import { CandidatePair, type IceOptions } from "../src/iceBase";
import type { Message } from "../src/stun/message";
import type { Protocol, TransactionRequestOptions } from "../src/types/model";

export const TURN_TEST_USERNAME = "turn-user";
export const TURN_TEST_PASSWORD = "turn-password";

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
  onDataReceived = new Event<[Buffer, Address?]>();
  sentMessages: Message[] = [];
  sendStunCount = 0;
  requestTimes: number[] = [];
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
      return [{} as Message, ["192.0.2.2", 5000] as const];
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
