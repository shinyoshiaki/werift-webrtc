import { randomUUID } from "crypto";
import { Candidate, candidateFoundation, candidatePriority } from "./candidate";
import {
  type IceCandidateErrorInfo,
  type IceServerReachedInfo,
  MissingMappedAddressError,
} from "./candidateError";
import type { MdnsLookup } from "./dns/lookup";
import type { IceGatheringErrorInfo } from "./gatheringError";
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
   * The peer advertised `a=ice-options:renomination`. With
   * {@link IceOptions.renomination} the controlling agent then nominates with
   * the NOMINATION attribute (see `renomination`).
   */
  remoteRenomination?: boolean;
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
  /**
   * A STUN or TURN server of the current generation's gathering gave no
   * candidate (see {@link IceCandidateErrorInfo}). Optional so that other
   * implementations of this interface keep compiling.
   */
  readonly onIceCandidateError?: Event<[IceCandidateErrorInfo]>;
  /**
   * A STUN or TURN server of the current generation's gathering answered
   * (see {@link IceServerReachedInfo}). Optional like onIceCandidateError.
   */
  readonly onIceServerReached?: Event<[IceServerReachedInfo]>;
  /**
   * The current generation's gathering reported an error (see
   * {@link IceGatheringErrorInfo}): the interfaces could not be enumerated,
   * it ended without any local candidate, or it failed unexpectedly.
   * Optional like onIceCandidateError.
   */
  readonly onGatheringError?: Event<[IceGatheringErrorInfo]>;

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
  /**
   * The largest nomination the peer sent for this pair while this agent was
   * controlled: the NOMINATION attribute's value (renomination), or 1 for
   * USE-CANDIDATE. The controlled agent selects the nominated pair with the
   * largest value, the higher-priority one between equal values.
   */
  remoteNomination = 0;
  /**
   * The NOMINATION value this agent (controlling, renomination) sent for the
   * pair and the peer answered; 0 when it did not renominate the pair.
   */
  nomination = 0;
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

/** Default of {@link IceOptions.incomingCheckTimeout}, in seconds. */
export const DEFAULT_INCOMING_CHECK_TIMEOUT = 30;
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

// Failover of the selected pair without an ICE restart (semi-aggressive
// nomination and renomination, full ICE, not ICE-TCP). The values follow
// libwebrtc (`p2p/base/connection.h`, `p2p/base/ice_controller_interface.h`,
// `basic_ice_controller.cc`); the libwebrtc name is given where it differs.

/**
 * Ping interval (ms) of a pair that is weak (a check went unanswered) or
 * stabilizing (fewer than {@link MIN_PINGS_AT_WEAK_PING_INTERVAL} responses
 * since it began to be monitored). libwebrtc:
 * `WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL`.
 */
export const WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL = 900;

/**
 * Ping interval (ms) of a stable backup pair (multiplied by a random 0.8–1.2).
 * libwebrtc: `STABLE_WRITABLE_CONNECTION_PING_INTERVAL`.
 */
export const STABLE_WRITABLE_CONNECTION_PING_INTERVAL = 2500;

/**
 * Responses a pair needs, pinged at the weak interval, before it counts as
 * stable. libwebrtc: `MIN_PINGS_AT_WEAK_PING_INTERVAL`.
 */
export const MIN_PINGS_AT_WEAK_PING_INTERVAL = 3;

/**
 * A pair is no longer writable once at least this many consecutive checks
 * went unanswered and {@link CONNECTION_WRITE_CONNECT_TIMEOUT} passed since
 * its last response. libwebrtc: `CONNECTION_WRITE_CONNECT_FAILURES`.
 */
export const CONNECTION_WRITE_CONNECT_FAILURES = 5;

/** See {@link CONNECTION_WRITE_CONNECT_FAILURES} (ms). libwebrtc: `CONNECTION_WRITE_CONNECT_TIMEOUT`. */
export const CONNECTION_WRITE_CONNECT_TIMEOUT = 5000;

/**
 * A pair that received nothing (response, request or data) for this long
 * (ms) is weak. libwebrtc: `WEAK_CONNECTION_RECEIVE_TIMEOUT`.
 */
export const WEAK_CONNECTION_RECEIVE_TIMEOUT = 2500;

/**
 * How long (ms) the selected pair must have stopped receiving (nothing
 * received for {@link WEAK_CONNECTION_RECEIVE_TIMEOUT}) before the
 * controlling agent fails over to a backup that receives, without waiting
 * for the selected pair to become unwritable. libwebrtc:
 * `receiving_switching_delay` (default 1000 ms).
 */
export const RECEIVING_SWITCHING_DELAY = 1000;

/**
 * A backup pair that received nothing for this long (ms) is dropped (its
 * state becomes Failed) and the next pair of its socket is monitored. The
 * same value as {@link CONSENT_TIMEOUT}. libwebrtc:
 * `DEAD_CONNECTION_RECEIVE_TIMEOUT`.
 */
export const DEAD_CONNECTION_RECEIVE_TIMEOUT = CONSENT_TIMEOUT * 1000;

/**
 * Response timeout (ms) of a backup check while the pair's RTT is still
 * unknown (it never answered a check of this agent). libwebrtc starts a
 * connection's RTT estimate at `DEFAULT_RTT` (3000 ms); the consent default
 * ({@link CONSENT_RESPONSE_TIMEOUT}, 1 s) would never let a backup path
 * slower than that become valid. Once the pair answered, the timeout follows
 * its RTT ({@link consentResponseTimeoutMs}).
 */
export const BACKUP_UNKNOWN_RTT_RESPONSE_TIMEOUT = 3000;

/**
 * After the selected pair's consent expired (RFC 7675: no more application
 * data on it), how long (ms) the agent stays `disconnected` waiting for the
 * selection to move to a writable backup (its own failover nomination, or
 * the peer's when controlled) before it fails. A peer that fails over does
 * so 5–10 s after the path broke, long before the 30 s expiry; the grace
 * covers a nomination still in flight. werift's own value.
 */
export const FAILOVER_CONSENT_EXPIRED_GRACE = 10_000;

/**
 * Pairs of one local socket (or TURN allocation) tried as its backup before
 * the socket waits for a retry (1, 2, 4, 8, 16 s, then every 16 s) and starts
 * again from its highest-priority pair. werift's own limit.
 */
export const FAILOVER_BACKUP_ATTEMPTS = 3;

/**
 * Consecutive responses a pair the agent failed over from needs before the
 * selection may move back to it (or to another pair of its socket). Keeps
 * the selection from flapping. werift's own value (libwebrtc relies on
 * {@link MIN_PINGS_AT_WEAK_PING_INTERVAL} for the same purpose).
 */
export const FAILOVER_RECOVERY_RESPONSES = 3;

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
  /**
   * The application's names (URLs) for this server. Metadata only: the
   * allocation does not use them. They are passed through unchanged to
   * {@link IceServerRef.urls} of `Connection.onIceCandidateError`, so a
   * failure can be matched to the configured server without exposing the
   * credential. Duplicates merged by {@link normalizeIceServerOptions} have
   * their urls merged.
   */
  urls?: string[];
};

/** A TURN server as gathering uses it (see {@link normalizeIceServerOptions}). */
export type NormalizedTurnServer = Required<Omit<TurnServerOptions, "urls">> &
  Pick<TurnServerOptions, "urls">;

/**
 * The application's name (URL) of a STUN server, reported in
 * {@link IceServerRef.urls} of `Connection.onIceCandidateError`. Metadata
 * only; several entries may name the same address.
 */
export type StunServerUrl = { address: Address; url: string };

/**
 * Thresholds of the failover of the selected pair ({@link IceOptions.failover}),
 * after libwebrtc's `RTCConfiguration` fields of the same meaning. Lower
 * values fail over sooner and also on a shorter loss burst.
 */
export interface IceFailoverOptions {
  /**
   * Consecutive unanswered checks after which a pair is unwritable (together
   * with `unwritableTimeout`). An integer of at least 1; defaults to
   * {@link CONNECTION_WRITE_CONNECT_FAILURES} (5). libwebrtc:
   * `ice_unwritable_min_checks`.
   */
  unwritableMinChecks?: number;
  /**
   * Time (ms) since a pair's last response after which it is unwritable
   * (together with `unwritableMinChecks`). At least 0; defaults to
   * {@link CONNECTION_WRITE_CONNECT_TIMEOUT} (5000). libwebrtc:
   * `ice_unwritable_timeout`.
   */
  unwritableTimeout?: number;
  /**
   * Time (ms) without receiving anything (response, request or data) after
   * which a pair is weak (checked at the weak interval, 900 ms) and stops
   * receiving. Greater than 0; defaults to
   * {@link WEAK_CONNECTION_RECEIVE_TIMEOUT} (2500). libwebrtc:
   * `receiving_timeout`.
   */
  receivingTimeout?: number;
  /**
   * Time (ms) the selected pair must have stopped receiving (one of its
   * checks unanswered as well) before the controlling agent fails over to a
   * backup that receives, before the selected pair becomes unwritable. At
   * least 0; defaults to {@link RECEIVING_SWITCHING_DELAY} (1000).
   * libwebrtc: `receiving_switching_delay`.
   */
  receivingSwitchingDelay?: number;
}

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
   * Seconds `connect()` waits for a connectivity check from the peer when it
   * has no candidate pair of its own to check after both sides ended their
   * candidates: the peer offered only active TCP candidates (RFC 6544), or
   * none this agent can reach. A check from the peer adds a peer-reflexive
   * pair and the connection proceeds; without one, `connect()` fails when the
   * time runs out. An ICE-lite agent, which sends no checks, waits the same
   * time whenever it has no candidate pair, also while it still gathers. The
   * deadline is fixed when the wait begins; once the local gathering ended
   * without a socket that could receive a check, `connect()` fails at once.
   * Defaults to 30; 0 fails at once.
   */
  incomingCheckTimeout?: number;
  /**
   * Seconds to wait for a TURN TCP/TLS connection to be established.
   * Defaults to 8.
   */
  turnConnectTimeout?: number;
  /**
   * With `nomination: "regular"`: milliseconds the controlling agent keeps
   * checking before it nominates (RFC 8445 §8.1.1 regular nomination). The
   * default semi-aggressive nomination does not wait. Counted from the later of the first
   * valid pair and the last pair added that outranks the best valid pair, so
   * a higher-priority candidate trickled shortly after a lower-priority one
   * succeeded can still be selected. Once both sides signalled
   * end-of-candidates and no higher-priority pair is still being checked, the
   * best valid pair is nominated at once. Defaults to 300; 0 nominates the
   * best valid pair as soon as one exists. A negative or non-finite value
   * falls back to the default.
   */
  nominationDelayMs?: number;
  /**
   * How the controlling agent nominates toward a full ICE peer when
   * renomination is not in use (see `renomination`).
   *
   * - `"semi-aggressive"` (default, as libwebrtc / Chrome): a check carries
   *   USE-CANDIDATE while no pair is selected and for every pair that
   *   outranks the selected one. The first pair whose check succeeds is
   *   selected at once; checks of higher-priority pairs go on, and one that
   *   succeeds later replaces the selection. Consent checks of the selected
   *   pair carry USE-CANDIDATE as well.
   * - `"regular"`: RFC 8445 §8.1.1 regular nomination. Checks carry no
   *   USE-CANDIDATE; after `nominationDelayMs` (or end-of-candidates) the
   *   best valid pair is nominated once with a separate check and never
   *   replaced.
   *
   * Toward an ICE-lite peer the first valid pair is nominated in either mode.
   */
  nomination?: "semi-aggressive" | "regular";
  /**
   * Renomination (draft-thatcher-ice-renomination, as libwebrtc implements
   * it). When enabled the agent advertises `a=ice-options:renomination`
   * (packages/webrtc). When the peer advertised it too, the controlling agent
   * nominates with the NOMINATION attribute (0xC001) and an increasing value
   * instead of USE-CANDIDATE: it nominates the first valid pair, keeps
   * checking higher-priority pairs and renominates a better one when its
   * check succeeds. This replaces `nomination` for that session.
   *
   * The controlled agent always honours the NOMINATION attribute: it selects
   * the pair with the largest value. Defaults to false.
   */
  renomination?: boolean;
  /**
   * Thresholds of the failover of the selected pair without an ICE restart
   * (semi-aggressive nomination or renomination, full ICE, not ICE-TCP).
   * Each unset or invalid value keeps its default, which follows libwebrtc.
   * See {@link IceFailoverOptions}.
   */
  failover?: IceFailoverOptions;
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
   * The application's names (URLs) of {@link IceOptions.stunServers}, by
   * address. Metadata only, reported in {@link IceServerRef.urls} of
   * `Connection.onIceCandidateError`; replaced together with the STUN
   * servers (see {@link mergeIceServerOptions}).
   */
  stunServerUrls?: StunServerUrl[];
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
   * `connect()`, no packet is sent). A family without such a server has no
   * default-route address: no other address (no public one) is probed in
   * its place, and its host candidates keep the gathering order. With a STUN
   * server, a wildcard socket per family maps the route the
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
  // Highest priority first; pairs of equal priority keep their order.
  return pairs.sort((a, b) =>
    compareCandidatePairPriority(
      b.localCandidate,
      b.remoteCandidate,
      a.localCandidate,
      a.remoteCandidate,
      iceControlling,
    ),
  );
}

/** RFC 8445 §6.1.2.3: G is the controlling agent's candidate priority, D the controlled one's. */
function pairPriorityTerms(
  local: Pick<Candidate, "priority">,
  remote: Pick<Candidate, "priority">,
  iceControlling: boolean,
) {
  const G = iceControlling ? local.priority : remote.priority;
  const D = iceControlling ? remote.priority : local.priority;
  return { min: Math.min(G, D), max: Math.max(G, D), tie: G > D ? 1 : 0 };
}

// 5.7.2.  Computing Pair Priority and Ordering Pairs
/**
 * `2^32 * MIN(G,D) + 2 * MAX(G,D) + (G > D ? 1 : 0)` (RFC 8445 §6.1.2.3).
 * The value can exceed `Number.MAX_SAFE_INTEGER`, so it is approximate;
 * order pairs with `compareCandidatePairPriority`, which is exact.
 */
export function candidatePairPriority(
  local: Pick<Candidate, "priority">,
  remote: Pick<Candidate, "priority">,
  iceControlling: boolean,
) {
  const { min, max, tie } = pairPriorityTerms(local, remote, iceControlling);
  return 2 ** 32 * min + 2 * max + tie;
}

/**
 * Exact comparison of two pair priorities (RFC 8445 §6.1.2.3): negative
 * when pair `a` has the lower priority, positive when the higher, 0 when equal.
 */
export function compareCandidatePairPriority(
  aLocal: Pick<Candidate, "priority">,
  aRemote: Pick<Candidate, "priority">,
  bLocal: Pick<Candidate, "priority">,
  bRemote: Pick<Candidate, "priority">,
  iceControlling: boolean,
) {
  const a = pairPriorityTerms(aLocal, aRemote, iceControlling);
  const b = pairPriorityTerms(bLocal, bRemote, iceControlling);
  return a.min - b.min || a.max - b.max || a.tie - b.tie;
}

/**
 * Query `stunServer` from `protocol` for a server-reflexive candidate.
 * Unlike {@link serverReflexiveCandidate} it rejects with the reason of a
 * failure. `base` is used for wildcard sockets that advertise no host
 * candidate themselves.
 */
export async function queryServerReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address,
  base?: Pick<Candidate, "host" | "port" | "transport" | "component"> &
    Partial<Pick<Candidate, "tcptype">>,
): Promise<Candidate> {
  const localCandidate = base ?? protocol.localCandidate;
  if (!localCandidate) {
    throw new Error("protocol has no local candidate");
  }

  const request = new Message(methods.BINDING, classes.REQUEST);
  const [response] = await protocol.request(request, stunServer);
  const mapped = response.getAttributeValue("XOR-MAPPED-ADDRESS") as
    | Address
    | undefined;
  if (!mapped) {
    throw new MissingMappedAddressError(stunServer);
  }

  return new Candidate(
    candidateFoundation("srflx", localCandidate.transport, localCandidate.host),
    localCandidate.component,
    localCandidate.transport,
    candidatePriority("srflx", {
      transport: localCandidate.transport,
      tcptype: localCandidate.tcptype,
    }),
    mapped[0],
    mapped[1],
    "srflx",
    localCandidate.host,
    localCandidate.port,
    localCandidate.tcptype,
  );
}

/**
 * Query a STUN server for a server-reflexive candidate. This compatibility
 * helper resolves `undefined` on failure; use
 * {@link queryServerReflexiveCandidate} when the failure reason is needed.
 */
export async function serverReflexiveCandidate(
  protocol: Protocol,
  stunServer: Address,
  base?: Pick<Candidate, "host" | "port" | "transport" | "component"> &
    Partial<Pick<Candidate, "tcptype">>,
): Promise<Candidate | undefined> {
  return queryServerReflexiveCandidate(protocol, stunServer, base).catch(
    (error) => {
      log("error serverReflexiveCandidate", error);
      return undefined;
    },
  );
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
    | "stunServerUrls"
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
 * - a TURN transport left unset is "udp";
 * - the `urls` of merged TURN duplicates are merged (in order, once each).
 *
 * The built-in default STUN server is not added here; Connection falls back
 * to it when the result has no STUN server.
 */
export function normalizeIceServerOptions(options: IceServerFields): {
  stunServers: Address[];
  turnServers: NormalizedTurnServer[];
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

  const turnServers: NormalizedTurnServer[] = [];
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
    const urls = Array.isArray(server.urls)
      ? server.urls.filter((url) => typeof url === "string")
      : undefined;
    const entry: NormalizedTurnServer = {
      address,
      username,
      password,
      transport: server.transport ?? "udp",
      ...(urls ? { urls: [...new Set(urls)] } : {}),
    };
    const existing = turnServers.find(
      (known) =>
        sameAddress(known.address, entry.address) &&
        known.transport === entry.transport &&
        known.username === entry.username &&
        known.password === entry.password,
    );
    if (existing) {
      // One allocation serves both: it answers to every name of them.
      if (entry.urls) {
        existing.urls = [...new Set([...(existing.urls ?? []), ...entry.urls])];
      }
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
    stunServerUrls: update.stunServerUrls,
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
