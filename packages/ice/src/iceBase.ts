import { randomUUID } from "crypto";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import type { MdnsLookup } from "./dns/lookup";
import type { Cancelable } from "./helper";
import {
  type Address,
  debug,
  type Event,
  type InterfaceAddresses,
  type TlsConnectionOptions,
} from "./imports/common";
import { classes, type MessageIntegrityMode, methods } from "./stun/const";
import { Message } from "./stun/message";
import type { Protocol } from "./types/model";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

export interface IceConnection {
  iceLite: boolean;
  iceControlling: boolean;
  localUsername: string;
  localPassword: string;
  remotePassword: string;
  remoteUsername: string;
  remoteIsLite: boolean;
  /**
   * The remote `a=ice-options` tokens (RFC 8839 §5.6), e.g. `trickle`,
   * `ice2`. Informational: werift already follows RFC 8445, so no token
   * changes how checks or nomination run.
   */
  remoteIceOptions?: string[];
  /** The remote declared `ice2`: an RFC 8445 agent (RFC 8445 §10). */
  readonly remoteIce2?: boolean;
  checkList: CandidatePair[];
  localCandidates: Candidate[];
  remoteCandidates: Candidate[];
  candidatePairs: CandidatePair[];
  /**
   * STUN servers gathering queries, normalized from the options (see
   * {@link normalizeIceServerOptions}). Optional so that other
   * implementations of this interface keep compiling.
   */
  stunServers?: Address[];
  /** TURN servers gathering allocates on, each with its own credential. */
  turnServers?: TurnServerOptions[];
  /** @deprecated The first of {@link IceConnection.stunServers}. */
  stunServer?: Address;
  /** @deprecated The address of the first of {@link IceConnection.turnServers}. */
  turnServer?: Address;
  generation: number;
  options: IceOptions;
  remoteCandidatesEnd: boolean;
  localCandidatesEnd: boolean;
  /**
   * Resolves when `localCandidatesEnd` becomes true after `gatherCandidates()`
   * returned (server-reflexive queries that continue in the background), or
   * when the generation ends. Optional so that other implementations of this
   * interface keep compiling; without it gathering ends when
   * `gatherCandidates()` returns.
   */
  waitForLocalCandidatesEnd?(): Promise<void>;
  state: IceState;
  lookup?: MdnsLookup;
  nominated?: CandidatePair;

  readonly onData: Event<[Buffer]>;
  readonly stateChanged: Event<[IceState]>;
  readonly onIceCandidate: Event<[Candidate]>;

  restart(): void;
  /** Record the remote `a=ice-options` tokens (see remoteIceOptions). */
  setRemoteIceOptions?(options: string[]): void;
  /**
   * Optional staged-restart and provisional-generation support. An
   * implementation without them still restarts ICE at the final answer, but
   * cannot answer or run checks for the new generation during pranswer.
   */
  /**
   * `gatherOptions`: the options the staged generation gathers with (an ICE
   * server update applied at the commit); its provisional checks use only
   * the sockets those options allow. Defaults to the current options.
   */
  stageLocalCredentials?(
    usernameFragment: string,
    password: string,
    gatherOptions?: Partial<IceOptions>,
  ): void;
  discardStagedLocalCredentials?(usernameFragment: string): void;
  commitLocalCredentials?(usernameFragment: string, password: string): void;
  /**
   * The remote side alone restarted (new remote credentials in an answer):
   * drop the remote generation and its checks, keep the local credentials
   * and gathered candidates.
   */
  restartRemote?(): void;
  setProvisionalRemoteParams?(params: {
    usernameFragment: string;
    password: string;
  }): void;
  addProvisionalRemoteCandidate?(
    candidate: Candidate | undefined,
  ): Promise<void>;
  startProvisionalChecks?(): void;
  readonly provisionalNominated?: CandidatePair;

  setIceServers(options: Partial<IceOptions>): void;

  setRemoteParams(params: {
    iceLite: boolean;
    usernameFragment: string;
    password: string;
  }): void;

  /**
   * Gather the current generation's candidates. After an ICE restart the
   * candidates the kept sockets advertised are re-advertised synchronously;
   * only server work (STUN, TURN) is awaited.
   */
  gatherCandidates(): Promise<void>;

  /** Whether gathering contacts a STUN or TURN server. */
  readonly gathersFromServers?: boolean;

  connect(): Promise<void>;

  close(): Promise<void>;

  addRemoteCandidate(remoteCandidate: Candidate | undefined): Promise<void>;

  send(data: Buffer): Promise<void>;

  getDefaultCandidate(): Candidate | undefined;
  resetNominatedPair(): void;
  /** Drop remote candidates and pairs that name another remote ufrag. */
  dropOtherRemoteGenerations?(usernameFragment: string): void;
}

export interface CandidatePairStats {
  packetsSent: number;
  packetsReceived: number;
  bytesSent: number;
  bytesReceived: number;
  rtt?: number;
  totalRoundTripTime: number;
  roundTripTimeMeasurements: number;
  requestsReceived: number;
  requestsSent: number;
  responsesReceived: number;
  responsesSent: number;
  retransmissionsReceived: number;
  retransmissionsSent: number;
  consentRequestsSent: number;
}

export class CandidatePair implements CandidatePairStats {
  public protocol: Protocol;
  public remoteCandidate: Candidate;
  public iceControlling: boolean;

  readonly id = randomUUID().toString();
  handle?: Cancelable<void>;
  nominated = false;
  remoteNominated = false;
  // 5.7.4.  Computing States
  private _state: CandidatePairState = CandidatePairState.FROZEN;
  get state() {
    return this._state;
  }

  // Statistics tracking
  packetsSent = 0;
  packetsReceived = 0;
  bytesSent = 0;
  bytesReceived = 0;
  rtt?: number;
  totalRoundTripTime = 0;
  roundTripTimeMeasurements = 0;
  requestsReceived = 0;
  requestsSent = 0;
  responsesReceived = 0;
  responsesSent = 0;
  retransmissionsReceived = 0;
  retransmissionsSent = 0;
  consentRequestsSent = 0;
  private readonly requestTransactionIds = new Set<string>();

  toJSON() {
    return this.json;
  }

  get json() {
    return {
      protocol: this.protocol.type,
      localCandidate: this.localCandidate.toSdp(),
      remoteCandidate: this.remoteCandidate.toSdp(),
    };
  }

  constructor(
    protocol: Protocol,
    remoteCandidate: Candidate,
    iceControlling: boolean,
  ) {
    this.protocol = protocol;
    this.remoteCandidate = remoteCandidate;
    this.iceControlling = iceControlling;
  }

  updateState(state: CandidatePairState) {
    this._state = state;
  }

  get localCandidate() {
    if (!this.protocol.localCandidate) {
      throw new Error("localCandidate not exist");
    }
    return this.protocol.localCandidate;
  }

  get remoteAddr(): Address {
    return [this.remoteCandidate.host, this.remoteCandidate.port];
  }

  get component() {
    return this.localCandidate.component;
  }

  get priority() {
    return candidatePairPriority(
      this.localCandidate,
      this.remoteCandidate,
      this.iceControlling,
    );
  }

  get foundation() {
    return this.localCandidate.foundation;
  }

  noteIncomingRequest(transactionId: string) {
    const isRetransmission = this.requestTransactionIds.has(transactionId);
    if (!isRetransmission) {
      this.requestTransactionIds.add(transactionId);
      return false;
    }
    this.retransmissionsReceived++;
    return true;
  }
}

export const ICE_COMPLETED = 1 as const;
export const ICE_FAILED = 2 as const;

/** Basic consent check period in seconds (RFC 7675). Actual interval is 0.8–1.2× this. */
export const CONSENT_INTERVAL = 5;

/**
 * @deprecated Consent expiry is based on {@link CONSENT_TIMEOUT} (30s after the
 * last valid response), not a consecutive failure count. Kept for API compatibility.
 */
export const CONSENT_FAILURES = 6;

/** RFC 7675: consent expires this many seconds after the last valid response. */
export const CONSENT_TIMEOUT = 30;

/**
 * Default single-shot response wait for consent requests (ms) when RTT is unknown.
 * Independent of retransmission count. Downstream ICE-lite peers typically
 * answer in 150–300ms; 1s is a conservative default used by interop patches.
 */
export const CONSENT_RESPONSE_TIMEOUT = 1000;

/** RFC 8445 §14.3: ICE RTO must not be less than 500ms. */
export const CONSENT_RESPONSE_TIMEOUT_MIN = 500;

/**
 * Compute consent response wait from pair RTT (seconds).
 * Uses 2×RTT + 200ms jitter margin, floored at {@link CONSENT_RESPONSE_TIMEOUT_MIN}.
 * Falls back to {@link CONSENT_RESPONSE_TIMEOUT} when RTT is unavailable.
 */
export function consentResponseTimeoutMs(rttSeconds?: number): number {
  if (
    rttSeconds === undefined ||
    !Number.isFinite(rttSeconds) ||
    rttSeconds <= 0
  ) {
    return CONSENT_RESPONSE_TIMEOUT;
  }
  return Math.max(
    CONSENT_RESPONSE_TIMEOUT_MIN,
    Math.round(rttSeconds * 1000 * 2 + 200),
  );
}

/**
 * @enum
 */
export const CandidatePairState = {
  FROZEN: 0,
  WAITING: 1,
  IN_PROGRESS: 2,
  SUCCEEDED: 3,
  FAILED: 4,
} as const;
export type CandidatePairState =
  (typeof CandidatePairState)[keyof typeof CandidatePairState];

export type IceState =
  | "disconnected"
  | "closed"
  | "completed"
  | "new"
  | "connected"
  | "failed";

/** A TURN server and the credential and transport used for it. */
export type TurnServerOptions = {
  address: Address;
  username: string;
  password: string;
  /** Defaults to "udp" (with a TCP fallback when the UDP allocation fails). */
  transport?: "udp" | "tcp" | "tls";
};

export interface IceOptions {
  /** Advertise and operate as an ICE lite agent. */
  iceLite: boolean;
  useTcp: boolean;
  /**
   * Gather passive TCP host candidates (opens a listening TCP server per
   * interface). Defaults to true. Send-only agents that never accept inbound
   * connections can set this false to avoid the listener while still gathering
   * active TCP candidates.
   */
  tcpPassive?: boolean;
  /**
   * Seconds to wait for server-reflexive candidates while gathering.
   * Defaults to 5. Where UDP is blocked these STUN queries are never answered,
   * so the wait always runs to the timeout; agents that must not stall on such
   * networks can lower it.
   *
   * `gatherCandidates()` waits only for the representative sockets' queries
   * (see `stunServers`); the other host sockets' queries continue up to this
   * timeout in the background and end-of-candidates follows them.
   */
  stunGatherTimeout?: number;
  /**
   * Seconds to wait for a TURN TCP/TLS connection to be established.
   * Defaults to 8.
   */
  turnConnectTimeout?: number;
  /**
   * STUN servers queried while gathering, in priority order. Every IPv4 UDP
   * host socket queries each of them in parallel; equal mappings are
   * advertised once, different ones (a NAT that maps per destination) each.
   *
   * Without `interfaceAddresses`, each family with a STUN server also gets a
   * UDP socket bound to the wildcard address that advertises no host
   * candidate: the OS picks its route (a full-tunnel VPN, an interface the
   * host sockets do not cover), and its server-reflexive candidates carry
   * the related address `0.0.0.0` / `::`. The IPv4 wildcard socket queries
   * every server, the IPv6 one only the IPv6 literal servers. It checks only
   * the remote candidates whose route leaves from an address no UDP host
   * socket is bound to, so a peer on a covered path learns no
   * peer-reflexive candidate from it.
   *
   * `gatherCandidates()` returns once the representative sockets answered or
   * `stunGatherTimeout` ran out: the wildcard sockets and the host socket of
   * the default-route address (every host socket when a family has neither).
   * The other host sockets' server-reflexive candidates trickle through
   * `onIceCandidate`, and `localCandidatesEnd` follows the last of them
   * (`waitForLocalCandidatesEnd()`), so an interface that cannot reach the
   * STUN server does not delay the description.
   *
   * Merged with the deprecated `stunServer`: the singular one comes first,
   * duplicates are dropped (see {@link normalizeIceServerOptions}).
   */
  stunServers?: Address[];
  /**
   * TURN servers allocated on while gathering, in priority order. Each one
   * gets its own allocation with its own credential and transport; one that
   * fails or times out does not stop the others. Gathering ends when the
   * slowest allocation completes or fails (`turnConnectTimeout` bounds a
   * TCP/TLS connection, the STUN transaction timeout an unanswered request).
   * `turnTlsOptions`, `turnUdpFamily`, `turnConnectTimeout`, `portRange` and
   * `interfaceAddresses` apply to every TURN server.
   *
   * Merged with the deprecated `turnServer` / `turnUsername` /
   * `turnPassword` / `turnTransport`: the singular one comes first,
   * duplicates are dropped and an entry without username / password is
   * ignored (see {@link normalizeIceServerOptions}).
   */
  turnServers?: TurnServerOptions[];
  /** @deprecated Use {@link IceOptions.stunServers}. Kept as their first entry. */
  stunServer?: Address;
  /**
   * Whether the built-in public STUN server (stun.l.google.com:19302) is used
   * when no STUN server is given. Defaults to true; false gathers no
   * server-reflexive candidate unless a STUN server is set.
   */
  useDefaultStunServer?: boolean;
  /** @deprecated Use {@link IceOptions.turnServers}. Kept as their first entry. */
  turnServer?: Address;
  /** @deprecated Use {@link TurnServerOptions.username} of {@link IceOptions.turnServers}. */
  turnUsername?: string;
  /** @deprecated Use {@link TurnServerOptions.password} of {@link IceOptions.turnServers}. */
  turnPassword?: string;
  /** @deprecated Use {@link TurnServerOptions.transport} of {@link IceOptions.turnServers}. */
  turnTransport?: "udp" | "tcp" | "tls";
  /** Applied to every TLS TURN server. */
  turnTlsOptions?: TlsConnectionOptions;
  /**
   * Preferred IP family of a TURN/UDP socket, applied (to every TURN server)
   * only when the server is a hostname. Ignored for an IP literal server,
   * whose own family always selects the socket. Defaults to 4.
   */
  turnUdpFamily?: 4 | 6;
  forceTurn?: boolean;
  localPasswordPrefix?: string;
  useIpv4: boolean;
  useIpv6: boolean;
  useLinkLocalAddress?: boolean;
  portRange?: [number, number];
  /**
   * Local addresses to bind the UDP host sockets to, per family.
   *
   * The address given for a family (`udp4` / `udp6`) is the only host
   * address of that family: its UDP host candidate advertises the address and
   * port the socket is actually bound to, even when the address is not among
   * the enumerated network interfaces (loopback, tun, ...), and its TCP host
   * candidates use it too. Other enumerated addresses of that family are not
   * gathered. If the bind fails, the family has no UDP host candidate.
   *
   * A family left unspecified while the other one is set gathers no
   * enumerated addresses (only its `additionalHostAddresses`).
   *
   * Without any family set, every enumerated address gets its own UDP host
   * socket bound to that address (an IPv6 link-local one with its zone), so
   * the socket's packets leave from the advertised candidate address even on
   * a host with several network interfaces. An address whose bind fails, or
   * whose sends fail, loses only its own candidate; the other addresses are
   * unaffected. An `additionalHostAddresses` entry that is not assigned to a
   * local interface (a 1:1 NAT public address, for example) is gathered over
   * a wildcard socket. The enumerated addresses include costly networks (VPN
   * / tunnel interfaces: `ipsec`, `tun`, `utun`, `tap`) with a low local
   * preference; `vmnet` / `veth` interfaces are excluded. The default-route
   * address gets the highest local preference, so checks start with the path
   * the OS uses: the source address of the route to the first configured
   * STUN / TURN server that resolves in the family and has a route (UDP
   * `connect()`, no packet is sent), or of the route to the Internet without
   * one. With a STUN server, a wildcard socket per family maps the route the
   * OS picks (see `stunServers`).
   *
   * A family set to the wildcard address (`0.0.0.0` / `::`) gathers its
   * enumerated and additional addresses over wildcard sockets instead;
   * the wildcard address itself is never advertised.
   */
  interfaceAddresses?: InterfaceAddresses;
  /**
   * Host addresses gathered in addition to the enumerated ones. For a family
   * bound by `interfaceAddresses`, addresses other than the bound one are
   * ignored.
   */
  additionalHostAddresses?: string[];
  filterStunResponse?: (
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) => boolean;
  filterCandidatePair?: (pair: CandidatePair) => boolean;
  /**
   * Integrity attributes of the connectivity checks and consent requests this
   * agent sends (short-term credentials, RFC 8489):
   * - `"sha1"` (default): MESSAGE-INTEGRITY only, what every browser accepts.
   * - `"sha256"`: MESSAGE-INTEGRITY-SHA256 only. A peer that does not know
   *   the comprehension-required 0x001C attribute rejects such checks (420
   *   or no answer), so use it only with a peer known to support it.
   * - `"both"`: MESSAGE-INTEGRITY followed by MESSAGE-INTEGRITY-SHA256.
   *
   * Received requests and responses are accepted with either algorithm, and
   * a response is always signed with the algorithm of its request
   * (MESSAGE-INTEGRITY-SHA256 when the request carried it, RFC 8489 §9.1.3).
   */
  messageIntegrity?: MessageIntegrityMode;
}

export const defaultOptions: IceOptions = {
  iceLite: false,
  useTcp: false,
  useIpv4: true,
  useIpv6: true,
};

export function validateRemoteCandidate(candidate: Candidate) {
  // """
  // Check the remote candidate is supported.
  // """
  if (!["host", "relay", "srflx"].includes(candidate.type))
    throw new Error(`Unexpected candidate type "${candidate.type}"`);

  // ipaddress.ip_address(candidate.host)
  return candidate;
}

export function sortCandidatePairs(
  pairs: {
    localCandidate: Pick<Candidate, "priority">;
    remoteCandidate: Pick<Candidate, "priority">;
  }[],
  iceControlling: boolean,
) {
  return pairs
    .sort(
      (a, b) =>
        candidatePairPriority(
          a.localCandidate,
          a.remoteCandidate,
          iceControlling,
        ) -
        candidatePairPriority(
          b.localCandidate,
          b.remoteCandidate,
          iceControlling,
        ),
    )
    .reverse();
}

// 5.7.2.  Computing Pair Priority and Ordering Pairs
export function candidatePairPriority(
  local: Pick<Candidate, "priority">,
  remote: Pick<Candidate, "priority">,
  iceControlling: boolean,
) {
  const G = (iceControlling && local.priority) || remote.priority;
  const D = (iceControlling && remote.priority) || local.priority;
  return (1 << 32) * Math.min(G, D) + 2 * Math.max(G, D) + (G > D ? 1 : 0);
}

/**
 * Query a STUN server to obtain a server-reflexive candidate of `protocol`.
 * Its base is the protocol's host candidate, or `base` for a socket that
 * advertises no host candidate (the wildcard socket: related address
 * `0.0.0.0` / `::`).
 */
export async function serverReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address,
  base?: Pick<Candidate, "host" | "port" | "transport" | "component"> &
    Partial<Pick<Candidate, "tcptype">>,
) {
  // # perform STUN query
  const request = new Message(methods.BINDING, classes.REQUEST);
  try {
    const [response] = await protocol.request(request, stunServer);

    const localCandidate = base ?? protocol.localCandidate;
    if (!localCandidate) {
      throw new Error("not exist");
    }

    const candidate = new Candidate(
      candidateFoundation(
        "srflx",
        localCandidate.transport,
        localCandidate.host,
      ),
      localCandidate.component,
      localCandidate.transport,
      candidatePriority("srflx", {
        transport: localCandidate.transport,
        tcptype: localCandidate.tcptype,
      }),
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[0],
      response.getAttributeValue("XOR-MAPPED-ADDRESS")[1],
      "srflx",
      localCandidate.host,
      localCandidate.port,
      localCandidate.tcptype,
    );
    return candidate;
  } catch (error) {
    // todo fix
    log("error serverReflexiveCandidate", error);
  }
}

export function validateAddress(addr?: Address): Address | undefined {
  if (addr && Number.isNaN(addr[1])) {
    return [addr[0], 443];
  }
  return addr;
}

/** The STUN/TURN server fields of {@link IceOptions}, singular and plural. */
export type IceServerFields = Partial<
  Pick<
    IceOptions,
    | "stunServer"
    | "stunServers"
    | "turnServer"
    | "turnServers"
    | "turnUsername"
    | "turnPassword"
    | "turnTransport"
  >
>;

/** A STUN/TURN server address: validated (see {@link validateAddress}) or undefined. */
function validServerAddress(addr: unknown): Address | undefined {
  if (!Array.isArray(addr)) return undefined;
  const validated = validateAddress(addr as unknown as Address);
  if (!validated) return undefined;
  const [host, port] = validated;
  if (typeof host !== "string" || host === "") return undefined;
  if (typeof port !== "number" || !Number.isFinite(port)) return undefined;
  return validated;
}

const sameAddress = (a: Address, b: Address) => a[0] === b[0] && a[1] === b[1];

/**
 * The STUN and TURN servers `options` configure, the one place the singular
 * (deprecated) and plural fields are merged:
 *
 * - order: the singular server first, then the plural list in its order;
 * - duplicates (the same STUN address; the same TURN address, transport and
 *   credential) are kept once, at their first position;
 * - an invalid address (see {@link validateAddress}) is dropped, and so is a
 *   TURN server without username or password (it cannot allocate);
 * - a TURN transport left unset is "udp".
 *
 * The built-in default STUN server is not added here; Connection falls back
 * to it when the result has no STUN server.
 */
export function normalizeIceServerOptions(options: IceServerFields): {
  stunServers: Address[];
  turnServers: Required<TurnServerOptions>[];
} {
  const stunServers: Address[] = [];
  for (const server of [options.stunServer, ...(options.stunServers ?? [])]) {
    if (server === undefined) continue;
    const address = validServerAddress(server);
    if (!address) {
      log("invalid STUN server ignored", server);
      continue;
    }
    if (stunServers.some((existing) => sameAddress(existing, address))) {
      continue;
    }
    stunServers.push(address);
  }

  const turnServers: Required<TurnServerOptions>[] = [];
  const configured: Partial<TurnServerOptions>[] = [
    ...(options.turnServer !== undefined
      ? [
          {
            address: options.turnServer,
            username: options.turnUsername,
            password: options.turnPassword,
            transport: options.turnTransport,
          },
        ]
      : []),
    ...(options.turnServers ?? []),
  ];
  for (const server of configured) {
    const address = validServerAddress(server?.address);
    if (!address) {
      log("invalid TURN server ignored", server?.address);
      continue;
    }
    const { username, password } = server;
    if (!username || !password) {
      log("TURN server without username / credential ignored", address);
      continue;
    }
    const entry: Required<TurnServerOptions> = {
      address,
      username,
      password,
      transport: server.transport ?? "udp",
    };
    if (
      turnServers.some(
        (existing) =>
          sameAddress(existing.address, entry.address) &&
          existing.transport === entry.transport &&
          existing.username === entry.username &&
          existing.password === entry.password,
      )
    ) {
      continue;
    }
    turnServers.push(entry);
  }
  return { stunServers, turnServers };
}

/**
 * `current` with an ICE server update applied (Connection.setIceServers): the
 * STUN/TURN fields, singular and plural, are replaced, an undefined one
 * included, so a STUN-only update cannot leave a previous TURN
 * host/credential behind; forceTurn and useTcp change only when given.
 */
export function mergeIceServerOptions<T extends Partial<IceOptions>>(
  current: T,
  update: Partial<IceOptions>,
): T {
  return {
    ...current,
    stunServer: update.stunServer,
    stunServers: update.stunServers,
    turnServer: update.turnServer,
    turnServers: update.turnServers,
    turnUsername: update.turnUsername,
    turnPassword: update.turnPassword,
    turnTransport: update.turnTransport,
    turnTlsOptions: update.turnTlsOptions,
    turnUdpFamily: update.turnUdpFamily,
    forceTurn: update.forceTurn ?? current.forceTurn,
    useTcp: update.useTcp ?? current.useTcp,
  };
}

/**
 * Whether a generation gathered with `options` is relay-only: forceTurn (the
 * "relay" ICE transport policy). The policy holds whatever the TURN settings
 * are: without a usable TURN server / credential (or for an ICE-lite agent,
 * which gathers no relay candidate) the generation has no candidate at all
 * rather than falling back to host / server-reflexive ones, so the local and
 * public addresses are neither advertised nor used for checks.
 */
export function isRelayOnlyGathering(options: Pick<IceOptions, "forceTurn">) {
  return !!options.forceTurn;
}

/**
 * Whether `options` carry at least one usable TURN server with its
 * credential, the ones a gathering with them allocates relay candidates from.
 */
export function hasTurnServer(options: IceServerFields) {
  return normalizeIceServerOptions(options).turnServers.length > 0;
}

/**
 * Whether `candidate`, kept from an earlier generation (an ICE restart keeps
 * the sockets), may be advertised and paired in a generation gathered with
 * `options`. A fresh gathering with the same options would not have produced
 * a host / server-reflexive candidate for a relay-only policy, a TCP host
 * candidate without useTcp, nor a relay candidate without a TURN server;
 * the kept ones are held back the same way.
 */
export function isCandidateAllowedByGatherOptions(
  candidate: Pick<Candidate, "type" | "transport">,
  options: Pick<IceOptions, "forceTurn"> &
    Partial<Pick<IceOptions, "useTcp">> &
    IceServerFields,
) {
  if (candidate.type === "relay") return hasTurnServer(options);
  if (isRelayOnlyGathering(options)) return false;
  if (candidate.transport.toLowerCase() === "tcp" && !options.useTcp) {
    return false;
  }
  return true;
}
