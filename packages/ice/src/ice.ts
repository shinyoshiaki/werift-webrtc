import * as timers from "node:timers/promises";
import { randomBytes } from "crypto";
import { Candidate, remoteTcpTypeForIncoming } from "./candidate";
import type {
  IceCandidateErrorInfo,
  IceServerReachedInfo,
  IceServerRef,
} from "./candidateError";
import { CandidateGatherer } from "./candidateGatherer";
import { ConsentFreshness } from "./consent";
import { MdnsLookup } from "./dns/lookup";
import {
  IceRestartedError,
  TransactionCancelled,
  type TransactionError,
  TransactionTimeout,
} from "./exceptions";
import { type Cancelable, cancelable, PQueue, randomString } from "./helper";
import {
  CandidatePair,
  CandidatePairState,
  CONSENT_INTERVAL,
  CONSENT_TIMEOUT,
  compareCandidatePairPriority,
  consentResponseTimeoutMs,
  DEFAULT_INCOMING_CHECK_TIMEOUT,
  defaultOptions,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  isCandidateAllowedByGatherOptions,
  isRelayOnlyGathering,
  mergeIceServerOptions,
  type NormalizedTurnServer,
  normalizeIceServerOptions,
  sortCandidatePairs,
  validateRemoteCandidate,
} from "./iceBase";
import { type Address, debug, Event } from "./imports/common";
import {
  buildCheckRequest,
  type CheckRequestParams,
  decodeTxUsername,
  isRoleConflict,
  receivedNomination,
  responseIntegrityMode,
} from "./internal/checkMessages";
import {
  connectionDatagramEvent,
  type IceDatagramContext,
  isAuthenticatedHandshakePair,
} from "./internal/datagram";
import { getDefaultRouteAddresses } from "./internal/defaultRoute";
import {
  getAssignedInterfaceAddresses,
  getHostInterfaceAddresses,
} from "./internal/hostInterfaces";
import { resolveHostAddresses } from "./internal/resolveHostAddresses";
import {
  type ConnectionSpedState,
  getConnectionSpedRuntime,
  isConnectionSpedEnabled,
  registerSpedCarryMaybeFlush,
  setConnectionSpedRuntime,
} from "./internal/sped-bind";
import { SpedBindingResponseCache } from "./internal/sped-binding-cache";
import {
  DEFAULT_NOMINATION_DELAY_MS,
  ICE_NOMINATION_ABANDONED,
  NOMINATION_ATTEMPTS,
  type NominationHint,
  type NominationHost,
  type NominationOutcome,
  pairKey,
  RegularNomination,
} from "./nomination/regularNomination";
import { SelectionReplacement } from "./nomination/selectionReplacement";
import { ProvisionalChecklist } from "./provisional";
import { type SpedRuntime, sameCandidatePair } from "./sped/runtime";
import {
  classes,
  methods,
  RETRY_MAX,
  RETRY_RTO,
  TCP_CHECK_RESPONSE_TIMEOUT_MS,
} from "./stun/const";
import { Message, parseMessage } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import type { Protocol, TransactionRequestOptions } from "./types/model";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

/**
 * One STUN connectivity-check transaction: initial send plus RETRY_MAX
 * retransmissions with doubling RTO. The SPED Binding Response replay cache
 * keeps an entry for this long (STUN retransmissions of the same request).
 */
function stunTransactionLifetimeMs() {
  const tries = 1 + RETRY_MAX;
  return RETRY_RTO * (2 ** tries - 1);
}

/** Fallback STUN server when none is configured (constructor / setIceServers). */
const DEFAULT_STUN_SERVER: Address = ["stun.l.google.com", 19302];
/**
 * The URL `onIceCandidateError` names the built-in default STUN server by:
 * it is in no configuration, so werift synthesizes one.
 */
export const DEFAULT_STUN_SERVER_URL = "stun:stun.l.google.com:19302";

// The ICE agent. This file keeps the public API, the lifecycle (restart,
// close, state), the protocol event wiring and the live checklist
// (connect / checkStart / checkComplete / checkIncoming). Its parts live in
// collaborators the agent supplies through a host object:
// - candidateGatherer.ts: host / server-reflexive / relay gathering
// - consent.ts: RFC 7675 consent freshness of the selected pair
// - provisional.ts: the checklist of an ICE restart negotiated with a pranswer
// - nomination/regularNomination.ts: RFC 8445 regular nomination
// - nomination/selectionReplacement.ts: semi-aggressive nomination /
//   renomination replacing the selection
// - internal/checkMessages.ts: building and reading connectivity checks
export class Connection implements IceConnection {
  private _iceControlling: boolean;
  /** @internal SPED wiring (see internal/sped-bind.ts); PeerConfig.sped only. */
  readonly internalSped: ConnectionSpedState = { enabled: false };
  /** @internal Source/generation-aware datagram event (see internal/datagram.ts). */
  internalDatagramEvent?: Event<[IceDatagramContext]>;

  localUsername = randomString(4);
  localPassword = randomString(22);
  remoteIsLite = false;
  /** The peer advertised `a=ice-options:renomination` (see `IceOptions.renomination`). */
  remoteRenomination = false;
  remoteIceOptions: string[] = [];
  remotePassword: string = "";
  remoteUsername: string = "";
  checkList: CandidatePair[] = [];
  localCandidates: Candidate[] = [];
  /**
   * STUN servers gathering queries: the configured ones (see
   * normalizeIceServerOptions), or the built-in default when none is
   * configured and useDefaultStunServer is not false.
   */
  stunServers: Address[] = [];
  /** Whether stunServers is the built-in default (none configured). */
  private usesDefaultStunServer = false;
  /** TURN servers gathering allocates on, one allocation each. */
  turnServers: NormalizedTurnServer[] = [];
  options: IceOptions;
  remoteCandidatesEnd = false;
  /**
   * End-of-candidates arrived while earlier candidates were still resolving
   * (mDNS). No candidate is accepted any more; `remoteCandidatesEnd` follows
   * once those resolutions settle.
   */
  private remoteCandidatesEndRequested = false;
  /**
   * mDNS resolutions of remote candidates that arrived before
   * end-of-candidates. close() (and restart()) closes `lookup`, which rejects
   * them at once.
   */
  private readonly remoteResolutions = new Set<Promise<string>>();
  localCandidatesEnd = false;
  /** connect() began this generation's checks (their outcome sets the state). */
  private checksBegun = false;
  /** connect() stopped scheduling checks (a later pair must start its own). */
  private schedulingStopped = false;
  /**
   * The waits of connect() (one per concurrent call) for the peer's first
   * check on an empty check list; woken when a pair is added or the local
   * gathering ends (waitForIncomingCheck).
   */
  private readonly incomingCheckWaits = new Set<AbortController>();
  generation = -1;
  /**
   * Counts every reset of the remote generation: a local ICE restart and a
   * remote-only one. Remote-side work (a candidate's mDNS lookup, the wait
   * for end-of-candidates, consent, a nomination in flight) belongs to the
   * value it started with. A remote-only restart leaves `generation` (the
   * local gathering's) alone.
   */
  private remoteGeneration = 0;
  /**
   * Local credentials STUN requests may use, by ufrag: the current ones, the
   * generation the last restart replaced and a staged (provisional) one.
   */
  userHistory: { [username: string]: string } = {};
  /** restart() ran once (the constructor's first generation exists). */
  private restarted = false;
  private readonly tieBreaker: bigint = randomBytes(8).readBigUInt64BE(0);
  state: IceState = "new";
  /** close() ran; unlike `state`, a restart does not reset it. */
  private closed = false;
  /** Resolves remote mDNS candidates; closed (pending lookups cancelled) by restart() and close(). */
  lookup?: MdnsLookup;

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  nominated?: CandidatePair;
  /** The ICE-lite nomination (first valid pair, in `checkStart`) is in flight. */
  private liteNominating = false;
  /** Regular nomination (RFC 8445 §8.1.1) of the live checklist. */
  private readonly nomination = new RegularNomination(
    this.liveNominationHost(),
  );
  /** Semi-aggressive nomination and renomination: replacing the selection. */
  private readonly selection = new SelectionReplacement({
    checkList: () => this.checkList,
    selected: () => this.nominated,
    controlling: () => this.iceControlling,
    closed: () => this.state === "closed",
    remoteGeneration: () => this.remoteGeneration,
    usesRenomination: () => this.usesRenomination(),
    usesSemiAggressiveNomination: () => this.usesSemiAggressiveNomination(),
    replacesSelection: () => this.replacesSelection(),
    replacesWith: (pair) => this.replacesWith(pair),
    outranks: (pair, other) => this.outranks(pair, other),
    bestValidPair: (pairs) => this.bestValidPair(pairs),
    isTcpPair: (pair) => this.isTcpPair(pair),
    check: (pair) => {
      pair.handle = this.checkStart(pair);
    },
    complete: (pair) => this.checkComplete(pair),
    sendNomination: (pair, signal, value) =>
      this.sendNomination(pair, signal, value),
    isStaleNomination: (pair, generation) =>
      this.isStaleNomination(pair, generation),
    roleConflict: () => this.switchRole(false),
  });
  /** See `NominationHint`; set by the restart that ends a provisional checklist. */
  private nominationHint?: NominationHint;
  /** USE-CANDIDATE re-sent for a pair selected before the agent became controlling (`confirmSelections`). */
  private readonly selectionConfirmations = new Set<AbortController>();
  /**
   * Aborted when the remote generation ends (restart, restartRemote, close):
   * every check and nomination transaction of that generation stops with it.
   *
   * Every STUN request of the agent and what cancels it (a late result of an
   * ended generation changes no state of the generation that replaced it):
   * - `checkStart` (live check): its handle (`pair.handle`: checklist
   *   completed, replaced, other remote ufrag dropped) and this signal; an
   *   aborted check changes nothing.
   * - `retryCheck` (487 role conflict / 401 retry): the handle of the check
   *   it replaces and this signal (the retry is a `checkStart`).
   * - regular nomination in `checkStart` (toward an ICE-lite peer): the
   *   check's signal; `isStaleNomination` guards `liteNominating`, the pair
   *   state and `checkComplete`.
   * - `RegularNomination` (live: `sendNomination`): this signal and the
   *   attempt's own, which `reset()` (restart, restartRemote,
   *   resetNominatedPair, close) and `invalidate()` (role change) abort; a
   *   result of a replaced attempt is ignored. Its delay timer is cleared by
   *   `reset()`.
   * - `ProvisionalChecklist` checks and nominations: `generation.checks`
   *   (`end()`, a replacement pranswer, close); `belongs()`, and
   *   the provisional `RegularNomination` as above.
   * - consent checks (`ConsentFreshness`): a per-request `AbortController`
   *   and `consent.stop()`; its session id.
   * - `serverReflexiveCandidate` (gathering): `protocol.close()`; otherwise
   *   it ends by its retransmission timeout, and `stale()` drops the
   *   candidate (or the failure) of an ended gather.
   * - TURN client requests: the `closing` signal and `TurnProtocol.close()`.
   * Regression tests: `tests/ice/check-cancel.test.ts`.
   */
  private remoteChecks = new AbortController();
  private checkListDone = false;
  /** Aborted by close(): a TURN allocation still running is released. */
  private readonly closing = new AbortController();
  /**
   * Results for connect() of the current generation. A restart replaces the
   * queue; a connect() of the replaced generation keeps the old one and
   * stops on that generation's `remoteChecks` signal instead (connectError).
   */
  private checkListState = new PQueue<number>();
  private earlyChecks: [Message, Address, Protocol][] = [];
  private earlyChecksDone = false;
  private localCandidatesStart = false;
  private protocols: Protocol[] = [];
  /** RFC 7675 consent freshness of the selected pair. */
  private readonly consent = new ConsentFreshness({
    selected: () => this.nominated,
    state: () => this.state,
    setState: (state) => this.setState(state),
    remoteGeneration: () => this.remoteGeneration,
    remotePassword: () => this.remotePassword,
    iceLite: () => this.iceLite,
    integrityAlgorithm: () => this.options.messageIntegrity,
    buildRequest: (pair) =>
      this.buildRequest({
        nominate: this.shouldNominateConsentRequest(pair),
        nomination: this.consentNomination(pair),
        localUsername: this.localUsername,
        remoteUsername: this.remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: pair.localCandidate,
      }),
    generation: () => this.generation,
    decorateRequest: (request, pair) => this.decorateSpedRequest(request, pair),
    onResponse: (response, addr, pair, generation) =>
      this.consumeSpedStun(response, addr, pair.protocol, pair, generation),
  });
  /** Host, server-reflexive and relay gathering (`CandidateGatherer`). */
  private readonly gatherer = new CandidateGatherer({
    options: () => this.options,
    iceLite: () => this.iceLite,
    generation: () => this.generation,
    localUsername: () => this.localUsername,
    protocols: () => this.protocols,
    stunServers: () => this.stunServers,
    turnServers: () => this.turnServers,
    defaultStunServer: () =>
      this.usesDefaultStunServer
        ? { address: DEFAULT_STUN_SERVER, url: DEFAULT_STUN_SERVER_URL }
        : undefined,
    isGathering: (generation) => this.isGathering(generation),
    closing: () => this.closing.signal,
    ensureProtocol: (protocol) => this.ensureProtocol(protocol),
    pairLocalProtocol: (protocol) => this.pairLocalProtocol(protocol),
    appendLocalCandidate: (candidate) => this.appendLocalCandidate(candidate),
    emitCandidateError: (stale, generation, server, failure, local) =>
      this.emitCandidateError(stale, generation, server, failure, local),
    emitServerReached: (stale, generation, server) =>
      this.emitServerReached(stale, generation, server),
  });
  /**
   * Settles when the background server-reflexive queries of the current
   * generation end (see {@link Connection.waitForLocalCandidatesEnd}).
   */
  private localCandidatesEndPromise?: Promise<void>;
  /** ICE restart generation checked beside the selected current pair. */
  private readonly provisionalChecklist = new ProvisionalChecklist({
    closed: () => this.closed,
    iceLite: () => this.iceLite,
    iceControlling: () => this.iceControlling,
    remoteIsLite: () => this.remoteIsLite,
    localCandidatesEnd: () => this.localCandidatesEnd,
    options: () => this.options,
    protocols: () => this.protocols,
    mdnsLookup: () => {
      this.lookup ??= new MdnsLookup();
      return this.lookup;
    },
    isUncheckedPair: (pair) => this.isUncheckedPair(pair),
    isWildcardProtocol: (protocol) =>
      this.gatherer.isWildcardProtocol(protocol),
    wildcardPathUncovered: (remoteCandidate) =>
      this.gatherer.wildcardPathUncovered(remoteCandidate),
    nominatesFullPeer: () => this.nominatesFullPeer(),
    usesRegularNomination: () => this.usesRegularNomination(),
    replacesWith: (pair) => this.replacesWith(pair),
    regularNominationPairs: (pairs) => this.regularNominationPairs(pairs),
    bestValidPair: (pairs) => this.bestValidPair(pairs),
    outranks: (pair, other) => this.outranks(pair, other),
    nominationDelayMs: () => this.nominationDelayMs,
    buildRequest: (params) => this.buildRequest(params),
    switchRole: (iceControlling) => this.switchRole(iceControlling),
  });
  readonly onData = new Event<[Buffer]>();
  readonly stateChanged = new Event<[IceState]>();
  readonly onIceCandidate: Event<[Candidate]> = new Event();
  /**
   * A STUN server query or TURN allocation of the current generation's
   * gathering failed (W3C `icecandidateerror`), synchronously and without
   * changing the gathering: other servers and sockets go on, and gathering
   * still completes. A server answering with an error gives its ERROR-CODE,
   * once per local socket and generation. One that is not reached (timeout,
   * `stunGatherTimeout`, DNS, connect or socket error) gives 701, once per
   * server and generation and only when no local socket reached it (a STUN
   * server is reported when the last socket's query ended). A TURN server's UDP attempt and its TCP fallback are
   * one failure, reported when both failed (a server's error code wins over
   * 701). A credential retry (401 / 438) that succeeds is not a failure.
   * Nothing is fired for a replaced generation or after close (the event
   * completes then). A STUN failure carries the host address of a socket
   * that asked; a TURN one carries none. The built-in default STUN server (none
   * configured, `useDefaultStunServer` not false) is named by the
   * synthesized URL {@link DEFAULT_STUN_SERVER_URL} in `server.urls`.
   */
  readonly onIceCandidateError = new Event<[IceCandidateErrorInfo]>();
  /**
   * A STUN or TURN server of the current generation's gathering answered:
   * a STUN query or TURN allocation gave a candidate, or the server sent an
   * error response (see {@link IceServerReachedInfo}). Synchronous; nothing
   * is fired for a replaced generation or after close.
   */
  readonly onIceServerReached = new Event<[IceServerReachedInfo]>();

  /** The staged ICE restart generation (`ProvisionalChecklist`). */
  private get provisional() {
    return this.provisionalChecklist.generation;
  }

  /** @internal SPED controller; unset unless PeerConfig.sped (or tests) attach it. */
  private get spedRuntime(): SpedRuntime | undefined {
    return getConnectionSpedRuntime(this);
  }
  private set spedRuntime(runtime: SpedRuntime | undefined) {
    setConnectionSpedRuntime(this, runtime);
  }
  private spedCarryInFlight = false;
  private spedCarryQueued = false;
  /**
   * After receiving SPED DATA, send one more Binding even without local L1
   * so ICE-Lite (Responses only) can put the next L1 datagram on the reply.
   */
  private spedSolicitPeerCarry = false;
  private spedCarryEpoch = 0;
  private spedIncomingStunDepth = 0;
  /**
   * Exact SPED Binding Response bytes keyed by STUN transaction id.
   * Handshake only: TTL = STUN transaction lifetime, LRU-capped.
   */
  private spedBindingCache = new SpedBindingResponseCache();

  constructor(_iceControlling: boolean, options?: Partial<IceOptions>) {
    this._iceControlling = _iceControlling;
    this.options = {
      ...defaultOptions,
      ...options,
    };
    if (this.iceLite) {
      this._iceControlling = false;
    }
    this.applyStunTurnServersFromOptions();
    registerSpedCarryMaybeFlush(this, () => this.maybeFlushSpedCarry());
    this.restart();
    log("new Connection", this.options);
  }

  /**
   * Replace STUN/TURN servers after construction.
   * Server-related fields are replaced (not partial-merged) so that removing
   * TURN clears residual credentials. W3C setConfiguration replaces the ICE
   * server list rather than merging additively.
   *
   * Used when servers are learned after the gatherer was built (e.g. WHIP
   * Link headers) and must take effect before the next gather pass.
   */
  setIceServers(options: Partial<IceOptions>) {
    // Server fields are assigned even when undefined, so a STUN-only update
    // or an unset TLS / address-family option leaves nothing behind.
    this.options = mergeIceServerOptions(this.options, options);
    this.applyStunTurnServersFromOptions();
    log("Connection ice servers updated", this.options);
  }

  /**
   * Derive Connection.stunServers / turnServers from this.options.
   * Shared by the constructor and setIceServers so both paths validate and
   * default identically.
   */
  private applyStunTurnServersFromOptions() {
    const { stunServers, turnServers } = normalizeIceServerOptions(
      this.options,
    );
    this.usesDefaultStunServer = !(
      stunServers.length > 0 || this.options.useDefaultStunServer === false
    );
    this.stunServers = this.usesDefaultStunServer
      ? [DEFAULT_STUN_SERVER]
      : stunServers;
    this.turnServers = turnServers;
  }

  /** @deprecated The first of {@link Connection.stunServers}. */
  get stunServer(): Address | undefined {
    return this.stunServers[0];
  }

  /** @deprecated Replaces {@link Connection.stunServers} with this one server (none for undefined). */
  set stunServer(server: Address | undefined) {
    this.stunServers = server ? [server] : [];
  }

  /** @deprecated The address of the first of {@link Connection.turnServers}. */
  get turnServer(): Address | undefined {
    return this.turnServers[0]?.address;
  }

  /**
   * @deprecated Replaces {@link Connection.turnServers} with this one server
   * and the deprecated turnUsername / turnPassword / turnTransport options
   * (none for undefined).
   */
  set turnServer(server: Address | undefined) {
    this.turnServers = server
      ? normalizeIceServerOptions({
          turnServer: server,
          turnUsername: this.options.turnUsername,
          turnPassword: this.options.turnPassword,
          turnTransport: this.options.turnTransport,
        }).turnServers
      : [];
  }

  get iceControlling() {
    return this._iceControlling;
  }

  set iceControlling(value: boolean) {
    if (this.iceLite) {
      value = false;
    }
    // While a pair is selected, keep the negotiated role. ICE restart clears
    // `nominated`, so offer/answer role and RFC 8445 role-conflict repair can
    // reassign controlling/controlled for the new generation.
    if (this.nominated) {
      return;
    }
    this.applyIceControlling(value);
  }

  get iceLite() {
    return this.options.iceLite;
  }

  async restart() {
    this.generation++;
    this.spedCarryEpoch++;
    this.abandonInFlightStunTransactions();
    this.remoteGeneration++;

    const previous = this.restarted
      ? { [this.localUsername]: this.localPassword }
      : {};
    this.localUsername = randomString(4);
    this.localPassword = randomString(22);
    if (this.options.localPasswordPrefix) {
      this.localPassword =
        this.options.localPasswordPrefix +
        this.localPassword.slice(this.options.localPasswordPrefix.length);
    }
    // Only the replaced generation's credentials stay beside the new ones
    // (a check the remote peer sent before it applied the restart is still
    // answered); older generations and staged credentials are dropped, so
    // the history does not grow with every restart.
    this.userHistory = {
      ...previous,
      [this.localUsername]: this.localPassword,
    };
    this.restarted = true;

    this.remoteUsername = "";
    this.remotePassword = "";
    this.localCandidates = [];
    this._remoteCandidates = [];
    this.remoteCandidatesEnd = false;
    this.remoteCandidatesEndRequested = false;
    this.remoteResolutions.clear();
    this.localCandidatesEnd = false;
    this.localCandidatesEndPromise = undefined;
    this.checksBegun = false;
    this.schedulingStopped = false;
    this.state = "new";
    this.lookup?.close?.();
    this.lookup = undefined;
    this.nominated = undefined;
    this.liteNominating = false;
    // Taken before `provisionalChecklist.end()` drops the provisional checklist.
    const hint = this.provisionalNominationHint();
    this.nomination.reset();
    this.selection.abort();
    this.nominationHint = hint;
    this.cancelChecks();
    this.checkList = [];
    this.checkListDone = false;
    this.checkListState = new PQueue<number>();
    this.earlyChecks = [];
    this.earlyChecksDone = false;
    this.localCandidatesStart = false;

    // protocolsはincomingのearlyCheckに使うかもしれないので残す
    for (const protocol of this.protocols) {
      if (protocol.localCandidate) {
        protocol.localCandidate.refreshId();
        protocol.localCandidate.generation = this.generation;
        protocol.localCandidate.ufrag = this.localUsername;
      }
    }

    // Tear down consent timers/transactions; new credentials require a new session.
    this.consent.stop();
    this.spedCarryInFlight = false;
    this.spedCarryQueued = false;
    this.spedSolicitPeerCarry = false;
    this.spedBindingCache.clear();
    this.spedRuntime?.reset(this.generation);
    this.provisionalChecklist.end();
  }

  /** DTLS handshake datagram on an authenticated current-generation pair. */
  private async sendHandshakeOnAuthenticatedPair(
    pair: CandidatePair,
    bytes: Buffer,
    generation: number,
  ) {
    if (generation !== this.generation) {
      return;
    }
    if (!isAuthenticatedHandshakePair(pair)) {
      return;
    }
    this.spedRuntime?.pinHandshakePath(pair);
    await pair.protocol.sendData(bytes, pair.remoteAddr);
  }

  /**
   * Direct fallback only on a current-generation authenticated CandidatePair.
   * No pair (e.g. earlyChecks) means no wire send.
   */
  private async maybeSendSpedFallback(
    protocol: Protocol,
    addr: Address,
    generation: number,
  ) {
    const runtime = this.spedRuntime;
    if (!runtime || generation !== this.generation) {
      return;
    }
    if (runtime.fallbackStarted || runtime.session.state !== "fallback") {
      return;
    }
    const pair = runtime.lastPath ?? this.findPairByAddr(protocol, addr);
    if (!pair || !isAuthenticatedHandshakePair(pair)) {
      return;
    }
    if (runtime.lastPath && !sameCandidatePair(runtime.lastPath, pair)) {
      return;
    }
    runtime.pinHandshakePath(pair);
    const packets = runtime.beginFallback();
    await runtime.hooks.onFallbackFlight(packets);
    for (const packet of packets) {
      await this.sendHandshakeOnAuthenticatedPair(pair, packet, generation);
    }
  }

  /**
   * UDP prflx with a pending C070-less Binding: lock unsupported once
   * trickle proves host/srflx, or end-of-candidates / nomination leaves a
   * lasting prflx. Nomination is enough: RFC 8838 allows ICE to complete
   * before end-of-candidates, and a nominated pair must not gain new
   * trickle candidates.
   * @returns the pair that locked unsupported, if any.
   */
  private settleSpedUnconfirmed(
    pair?: CandidatePair,
  ): CandidatePair | undefined {
    const runtime = this.spedRuntime;
    if (!runtime || runtime.session.peerSupport !== "unknown") {
      return undefined;
    }
    const pairs = pair ? [pair] : this.checkList;
    let locked: CandidatePair | undefined;
    for (const candidate of pairs) {
      if (
        runtime.settleUnconfirmedPair(candidate, {
          endOfCandidates: this.remoteCandidatesEnd,
          authenticated: isAuthenticatedHandshakePair(candidate),
          nominated: candidate.nominated || this.nominated === candidate,
        })
      ) {
        locked = candidate;
      }
    }
    return locked;
  }

  /**
   * Send the original L1 snapshot on the pair that locked fallback.
   * Prefer `preferredPair` so nomination settlement cannot race
   * `this.nominated` and land on an earlier authenticated checklist entry.
   */
  private async flushSpedUnconfirmedFallback(preferredPair?: CandidatePair) {
    const runtime = this.spedRuntime;
    if (!runtime || runtime.session.state !== "fallback") {
      return;
    }
    const pair =
      preferredPair ??
      this.nominated ??
      this.checkList.find((candidate) =>
        isAuthenticatedHandshakePair(candidate),
      );
    if (!pair) {
      return;
    }
    await this.maybeSendSpedFallback(
      pair.protocol,
      pair.remoteAddr,
      this.generation,
    );
  }

  /**
   * Only the remote side restarted (new remote credentials in an answer to an
   * offer that kept the local ones): the remote generation, its checks and
   * the selected pair start over; local credentials and candidates stay.
   */
  restartRemote() {
    this.remoteGeneration++;
    this.remoteUsername = "";
    this.remotePassword = "";
    this._remoteCandidates = [];
    this.remoteCandidatesEnd = false;
    this.remoteCandidatesEndRequested = false;
    this.remoteResolutions.clear();
    this.checksBegun = false;
    this.state = "new";
    this.nominated = undefined;
    this.liteNominating = false;
    this.nomination.reset();
    this.selection.abort();
    this.nominationHint = undefined;
    this.cancelChecks();
    this.checkList = [];
    this.checkListDone = false;
    this.checkListState = new PQueue<number>();
    this.earlyChecks = [];
    this.earlyChecksDone = false;
    this.consent.stop();
    this.provisionalChecklist.end();
  }

  /**
   * Stop the checks and nominations in flight for the checklist a restart
   * replaces (or close ends), and start a signal for the next generation.
   */
  private cancelChecks() {
    this.remoteChecks.abort();
    this.remoteChecks = new AbortController();
    for (const pair of this.checkList) pair.handle?.resolve?.();
    this.selection.clearRetries();
  }

  /** Accept provisional checks without changing the selected current pair. */
  stageLocalCredentials(
    usernameFragment: string,
    password: string,
    gatherOptions?: Partial<IceOptions>,
  ) {
    this.userHistory[usernameFragment] = password;
    this.provisionalChecklist.stage(usernameFragment, password, gatherOptions);
  }

  discardStagedLocalCredentials(usernameFragment: string) {
    if (this.provisional?.localUsername === usernameFragment) {
      this.provisionalChecklist.end();
    }
    if (usernameFragment !== this.localUsername) {
      delete this.userHistory[usernameFragment];
    }
  }

  /** Remote credentials of the provisional generation (pranswer). */
  setProvisionalRemoteParams({
    usernameFragment,
    password,
  }: {
    usernameFragment: string;
    password: string;
  }) {
    this.provisionalChecklist.setRemoteParams({ usernameFragment, password });
  }

  async addProvisionalRemoteCandidate(remoteCandidate: Candidate | undefined) {
    await this.provisionalChecklist.addRemoteCandidate(remoteCandidate);
  }

  /** Start checks for the provisional generation; the selected pair is kept. */
  startProvisionalChecks() {
    this.provisionalChecklist.start();
  }

  get provisionalNominated() {
    return this.provisionalChecklist.nominated;
  }

  /** Called after restart, before re-gathering the chosen generation. */
  commitLocalCredentials(usernameFragment: string, password: string) {
    // The credentials restart() generated were never signalled: these replace them.
    if (this.localUsername !== usernameFragment) {
      delete this.userHistory[this.localUsername];
    }
    this.localUsername = usernameFragment;
    this.localPassword = password;
    this.userHistory[usernameFragment] = password;
    for (const protocol of this.protocols) {
      if (protocol.localCandidate) {
        protocol.localCandidate.ufrag = usernameFragment;
      }
    }
  }

  /**
   * Drop the remote candidates (and their pairs) that name a ufrag other than
   * `usernameFragment`: they belong to another remote generation and cannot
   * pass checks with its credentials. Candidates without a ufrag stay.
   */
  dropOtherRemoteGenerations(usernameFragment: string) {
    const stale = (candidate: Candidate) =>
      !!candidate.ufrag && candidate.ufrag !== usernameFragment;
    this._remoteCandidates = this._remoteCandidates.filter(
      (candidate) => !stale(candidate),
    );
    for (const pair of this.checkList) {
      if (stale(pair.remoteCandidate)) pair.handle?.resolve?.();
    }
    this.checkList = this.checkList.filter(
      (pair) => !stale(pair.remoteCandidate),
    );
    this.nomination.evaluate();
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.liteNominating = false;
    this.nomination.reset();
    this.selection.abort();
    this.nominationHint = undefined;
    // Drop old pair's consent timers/transactions; restarted when a new pair is nominated.
    this.consent.stop();
  }

  get remoteIce2() {
    return this.remoteIceOptions.includes("ice2");
  }

  setRemoteIceOptions(options: string[]) {
    log("setRemoteIceOptions", options);
    this.remoteIceOptions = [...options];
    this.remoteRenomination = options.includes("renomination");
  }

  setRemoteParams({
    iceLite,
    usernameFragment,
    password,
  }: {
    iceLite: boolean;
    usernameFragment: string;
    password: string;
  }) {
    log("setRemoteParams", { iceLite, usernameFragment, password });
    this.remoteIsLite = iceLite;
    this.remoteUsername = usernameFragment;
    this.remotePassword = password;
    this.spedRuntime?.syncPathMtuFromConnection(this);
  }

  // 4.1.1 Gathering Candidates
  /**
   * Gather the local candidates of the current generation.
   *
   * After an ICE restart everything the kept sockets already advertised is
   * advertised again synchronously, before this method first awaits: the host
   * candidates and the server-reflexive address each kept socket had. Only
   * work that needs a server follows (a fresh STUN query, a new TURN
   * allocation), so a caller may let it finish in the background.
   */
  async gatherCandidates() {
    if (!this.localCandidatesStart) {
      this.localCandidatesStart = true;
      const generation = this.generation;

      // An ICE restart allocates TURN afresh, which is how a restart recovers
      // from an allocation that died: the previous one leaves the generation.
      const previousTurn = this.protocols.filter(
        (protocol) => protocol.localCandidate?.type === "relay",
      );
      // The generation keeps only the sockets a fresh gathering with the
      // current options would open: a relay-only policy or useTcp turned off
      // since the previous generation closes the kept host (UDP / TCP)
      // sockets, so they are neither advertised, paired nor reachable.
      const excluded = this.protocols.filter(
        (protocol) =>
          !previousTurn.includes(protocol) &&
          !!protocol.localCandidate &&
          !isCandidateAllowedByGatherOptions(
            protocol.localCandidate,
            this.options,
          ),
      );
      this.protocols = this.protocols.filter(
        (protocol) =>
          !previousTurn.includes(protocol) && !excluded.includes(protocol),
      );
      void Promise.allSettled(
        [...previousTurn, ...excluded].map((protocol) => protocol.close()),
      );

      // ICE restart keeps transport protocols; re-advertise their host candidates
      // with the new generation / ufrag before gathering additional addresses.
      for (const [family, wildcard] of this.gatherer.wildcardProtocols) {
        if (!this.protocols.includes(wildcard)) {
          // Closed with the excluded sockets, or still opening for the
          // replaced generation: a fresh one is opened if needed.
          this.gatherer.wildcardProtocols.delete(family);
        }
      }
      for (const protocol of this.protocols) {
        if (protocol.localCandidate) {
          protocol.localCandidate.generation = this.generation;
          protocol.localCandidate.ufrag = this.localUsername;
          // A wildcard socket's local candidate is one of its
          // server-reflexive candidates, re-advertised below.
          if (!this.gatherer.isWildcardProtocol(protocol)) {
            this.appendLocalCandidate(protocol.localCandidate);
          }
          for (const reflexive of this.gatherer.reflexiveBySocket.get(
            protocol,
          ) ?? []) {
            this.appendLocalCandidate(this.withGeneration(reflexive));
          }
        }
      }

      // A family bound to an explicit interface address gathers only that
      // address, so the advertised host candidate is the socket's address.
      const address = resolveHostAddresses({
        enumerated: getHostInterfaceAddresses(
          this.options.useIpv4,
          this.options.useIpv6,
          {
            useLinkLocalAddress: this.options.useLinkLocalAddress,
          },
        ),
        assigned: getAssignedInterfaceAddresses(),
        interfaceAddresses: this.options.interfaceAddresses,
        additionalHostAddresses: this.options.additionalHostAddresses,
        useIpv4: this.options.useIpv4,
        useIpv6: this.options.useIpv6,
        log,
      });

      // The default-route address of each family: the source address of the
      // route to the configured STUN / TURN servers (none without one: no
      // other address is probed). Its host candidate gets the highest local preference, and its
      // socket is a representative of the family's server-reflexive queries.
      // Probed while the sockets bind: no server work waits for it.
      const defaultRoutes = this.untilClosed(
        getDefaultRouteAddresses(this.options.useIpv4, this.options.useIpv6, [
          ...this.stunServers.map(([host]) => host),
          ...this.turnServers.map(({ address: [host] }) => host),
        ]),
      ).then((routes) => routes ?? []);

      const { primary, background } = this.gatherer.candidatePromises(
        address,
        this.options.stunGatherTimeout,
        generation,
        defaultRoutes,
      );
      // close() ends the gathering at once: the continuations above close
      // whatever a server query still opens for a closed agent.
      await this.untilClosed(Promise.allSettled(primary));

      // A later ICE restart (or close) owns the agent now: this gathering
      // neither completes that generation nor touches its state.
      if (!this.isGathering(generation)) return;
      const pending = background.filter(({ settled }) => !settled);
      if (pending.length === 0) {
        this.localCandidatesEnd = true;
        this.wakeIncomingCheckWaits();
      } else {
        // The other host sockets' server-reflexive candidates trickle in;
        // end-of-candidates follows the last of them.
        this.localCandidatesEndPromise = this.untilClosed(
          Promise.allSettled(pending.map(({ query }) => query)),
        ).then(() => {
          if (!this.isGathering(generation)) return;
          this.localCandidatesEnd = true;
          this.wakeIncomingCheckWaits();
          if (this.checksBegun) this.concludeCheckListIfExhausted();
        });
      }
    }
    // Gathering that finishes after connectivity checks began (an ICE restart
    // keeps gathering from its servers) must not overwrite their state: the
    // agent stays "new" while checking, and only the checks' outcome moves it.
    if (this.state === "new" && !this.checksBegun) this.setState("completed");
  }

  /**
   * Resolves when the current generation's gathering has ended
   * (`localCandidatesEnd`): {@link Connection.gatherCandidates} returns once
   * the host sockets, the TURN allocations and the representative socket's
   * server-reflexive query are done, while the other host sockets' queries
   * continue and trickle through `onIceCandidate`. Also resolves when the
   * agent closes or restarts (the generation ends without its end).
   */
  async waitForLocalCandidatesEnd() {
    await this.localCandidatesEndPromise;
  }

  /**
   * Resolves with `work`'s value, or with `undefined` once the agent closes,
   * whichever comes first: work that awaits the network stops waiting at
   * close(). The close listener is removed when `work` settles, so repeated
   * gatherings (ICE restarts) leave nothing attached to the agent: racing a
   * promise that resolves only at close keeps a reaction, and with it each
   * gathering's candidates, until the agent closes.
   */
  private untilClosed<T>(work: Promise<T>): Promise<T | undefined> {
    const signal = this.closing.signal;
    if (signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const onClose = () => resolve(undefined);
      signal.addEventListener("abort", onClose, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onClose);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onClose);
          reject(error);
        },
      );
    });
  }

  /**
   * Whether gathering started for `generation` still belongs to the agent:
   * no ICE restart replaced the generation and the agent is not closed.
   */
  private isGathering(generation: number) {
    return this.generation === generation && this.state !== "closed";
  }

  /** A copy of `candidate` labelled with the current generation and ufrag. */
  private withGeneration(candidate: Candidate) {
    return new Candidate(
      candidate.foundation,
      candidate.component,
      candidate.transport,
      candidate.priority,
      candidate.host,
      candidate.port,
      candidate.type,
      candidate.relatedAddress,
      candidate.relatedPort,
      candidate.tcptype,
      this.generation,
      this.localUsername,
    );
  }

  /** Whether gathering contacts a STUN or TURN server (more than re-advertising sockets). */
  get gathersFromServers() {
    return this.stunServers.length > 0 || this.turnServers.length > 0;
  }

  private appendLocalCandidate(candidate: Candidate) {
    this.localCandidates.push(candidate);
    this.onIceCandidate.execute(candidate);
  }

  /**
   * Report a failed STUN query / TURN allocation of the gathering whose
   * `stale` is given (see onIceCandidateError). A failure that is not
   * reported (cancelled), belongs to a replaced generation or arrives after
   * close is dropped. A listener that throws does not stop the gathering.
   */
  private emitCandidateError(
    stale: () => boolean,
    generation: number,
    server: IceServerRef,
    failure: { errorCode: number; errorText: string } | undefined,
    local?: { address: string; port: number },
  ) {
    if (!failure || stale() || this.closing.signal.aborted) return;
    const info: IceCandidateErrorInfo = {
      server,
      ...(local ? { address: local.address, port: local.port } : {}),
      errorCode: failure.errorCode,
      errorText: failure.errorText,
      generation,
    };
    log("ice candidate error", {
      server: { ...server, urls: undefined },
      errorCode: info.errorCode,
      errorText: info.errorText,
    });
    try {
      this.onIceCandidateError.execute(info);
    } catch (error) {
      log("onIceCandidateError listener threw", error);
    }
  }

  /** Report that `server` answered the gathering whose `stale` is given. */
  private emitServerReached(
    stale: () => boolean,
    generation: number,
    server: IceServerRef,
  ) {
    if (stale() || this.closing.signal.aborted) return;
    try {
      this.onIceServerReached.execute({ server, generation });
    } catch (error) {
      log("onIceServerReached listener threw", error);
    }
  }

  private ensureProtocol(protocol: Protocol) {
    protocol.onRequestReceived.subscribe((msg, addr, data) => {
      void this.handleBindingRequest(protocol, msg, addr, data);
    });
    protocol.onDataReceived.subscribe((data, addr) => {
      try {
        const pair = this.resolveDatagramPair(protocol, addr);
        const authenticated =
          addr !== undefined &&
          pair !== undefined &&
          isAuthenticatedHandshakePair(pair);
        connectionDatagramEvent(this).execute({
          bytes: data,
          // Never copy pair.remoteAddr into source: a missing addr must not
          // look like an authenticated 5-tuple match.
          source: addr ?? ["0.0.0.0", 0],
          protocol,
          pair,
          generation: this.generation,
          authenticated,
        });

        // Update statistics for the nominated pair
        const activePair = this.nominated;
        if (activePair && activePair.protocol === protocol) {
          activePair.packetsReceived++;
          activePair.bytesReceived += data.length;
        }
        if (!this.iceControlling && addr) {
          this.selection.controlledDataReceived(protocol, addr);
        }

        this.onData.execute(data);
      } catch (error) {
        log("dataReceived", error);
      }
    });
    protocol.onConnectionClosed?.subscribe((remoteAddr) => {
      this.handleConnectionClosed(protocol, remoteAddr);
    });
  }

  private async handleBindingRequest(
    protocol: Protocol,
    msg: Message,
    addr: Address,
    data: Buffer,
  ) {
    if (msg.messageMethod !== methods.BINDING) {
      this.respondError(msg, addr, protocol, [400, "Bad Request"]);
      return;
    }

    const txUsername = msg.getAttributeValue("USERNAME");
    if (typeof txUsername !== "string" || !txUsername.includes(":")) {
      return;
    }
    const { remoteUsername: localUsername } = decodeTxUsername(txUsername);
    const localPassword = this.userHistory[localUsername] ?? this.localPassword;

    // SPED (PeerConfig.sped) carries DTLS on the check exchange, so its
    // requests are HMAC-verified (RFC 8445 §7.3) and an older generation's
    // check never reaches the current state. Without SPED the agent keeps its
    // default handling: the MESSAGE-INTEGRITY of an incoming check is not
    // verified here (rejecting unverifiable checks with 401, RFC 8489 §9.1.3,
    // changes established behavior and is tracked separately).
    const spedBoundary = isConnectionSpedEnabled(this);
    let verified: Message | undefined = msg;
    if (spedBoundary) {
      verified = parseMessage(data, Buffer.from(localPassword, "utf8"));
      if (!verified) {
        log("drop unauthenticated Binding Request");
        return;
      }
    }

    const isCurrentGeneration = localUsername === this.localUsername;

    if (!isCurrentGeneration) {
      const provisional = this.provisional;
      const isProvisional =
        !!provisional && localUsername === provisional.localUsername;
      if (
        isProvisional &&
        provisional &&
        !this.provisionalChecklist.allows(provisional, protocol)
      ) {
        return;
      }
      if (
        (isProvisional || !spedBoundary) &&
        this.resolveRoleConflict(
          verified,
          addr,
          protocol,
          localPassword,
          this.iceControlling,
        )
      ) {
        return;
      }
      // The application filter applies to every generation's check, as for
      // the current generation (options.filterStunResponse).
      if (
        this.options.filterStunResponse &&
        !this.options.filterStunResponse(verified, addr, protocol)
      ) {
        return;
      }
      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        verified.transactionId,
      );
      response
        .setAttribute("XOR-MAPPED-ADDRESS", addr)
        .addIntegrity(
          Buffer.from(localPassword, "utf8"),
          this.spedRuntime?.session.embedding
            ? "sha1"
            : responseIntegrityMode(verified),
        )
        .addFingerprint();
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });
      if (provisional && isProvisional) {
        this.provisionalChecklist.checkIncoming(
          provisional,
          verified,
          addr,
          protocol,
        );
      } else if (!spedBoundary) {
        // Without SPED an older generation's check is handled as before.
        this.queueOrCheckIncoming(verified, addr, protocol);
      }
      return;
    }

    const { iceControlling } = this;
    this.spedIncomingStunDepth++;
    try {
      await this.handleCurrentGenerationBinding(
        protocol,
        verified,
        addr,
        localPassword,
        iceControlling,
        spedBoundary,
      );
    } finally {
      this.spedIncomingStunDepth--;
      if (this.spedIncomingStunDepth === 0 && this.spedCarryQueued) {
        this.spedCarryQueued = false;
        void this.flushSpedCarry();
      }
    }
  }

  /** Queue a check until connect() while the checklist is empty, else handle it. */
  private queueOrCheckIncoming(
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) {
    if (this.checkList.length === 0 && !this.earlyChecksDone) {
      this.earlyChecks.push([message, addr, protocol]);
    } else {
      this.checkIncoming(message, addr, protocol);
    }
  }

  /**
   * @returns true when the request is fully handled (an error response was
   * sent, or the role switched and the peer retries).
   */
  private resolveRoleConflict(
    verified: Message,
    addr: Address,
    protocol: Protocol,
    localPassword: string,
    iceControlling: boolean,
  ): boolean {
    // 7.2.1.1.  Detecting and Repairing Role Conflicts
    if (iceControlling && verified.attributesKeys.includes("ICE-CONTROLLING")) {
      if (this.tieBreaker >= verified.getAttributeValue("ICE-CONTROLLING")) {
        this.respondError(
          verified,
          addr,
          protocol,
          [487, "Role Conflict"],
          localPassword,
        );
        return true;
      } else {
        this.switchRole(false);
      }
    } else if (
      !iceControlling &&
      verified.attributesKeys.includes("ICE-CONTROLLED")
    ) {
      if (
        this.iceLite ||
        this.tieBreaker < verified.getAttributeValue("ICE-CONTROLLED")
      ) {
        this.respondError(
          verified,
          addr,
          protocol,
          [487, "Role Conflict"],
          localPassword,
        );
        return true;
      } else {
        this.switchRole(true);
        return true;
      }
    }

    return false;
  }

  private async handleCurrentGenerationBinding(
    protocol: Protocol,
    verified: Message,
    addr: Address,
    localPassword: string,
    iceControlling: boolean,
    spedBoundary: boolean,
  ) {
    if (
      this.resolveRoleConflict(
        verified,
        addr,
        protocol,
        localPassword,
        iceControlling,
      )
    ) {
      return;
    }

    if (
      this.options.filterStunResponse &&
      !this.options.filterStunResponse(verified, addr, protocol)
    ) {
      return;
    }

    const generation = this.generation;
    // SPED needs the pair (and its prflx candidate) before the response so
    // the response can carry DTLS, and holds every check until connect().
    // Without SPED a check is queued only while the checklist is still empty
    // and the pair is formed by checkIncoming() after the response.
    const deferIncoming = spedBoundary
      ? !this.earlyChecksDone
      : this.checkList.length === 0 && !this.earlyChecksDone;
    let pair = this.findPairByAddr(protocol, addr);
    if (!pair && spedBoundary) {
      pair = this.ensureIncomingPair(verified, addr, protocol);
    }

    const txHex = verified.transactionIdHex;
    const replayCached = async (bytes: Buffer) => {
      if (
        this.spedRuntime &&
        pair &&
        this.spedRuntime.isLiveGeneration(generation)
      ) {
        await this.spedRuntime.handleAuthenticatedStun(
          verified,
          addr,
          generation,
          pair,
        );
      }
      const replay = new Message(
        methods.BINDING,
        classes.RESPONSE,
        verified.transactionId,
      );
      Object.defineProperty(replay, "bytes", {
        configurable: true,
        enumerable: false,
        get: () => bytes,
      });
      protocol.sendStun(replay, addr).catch((e) => {
        log("sendStun error", e);
      });
      if (deferIncoming) {
        this.earlyChecks.push([verified, addr, protocol]);
      } else {
        this.checkIncoming(verified, addr, protocol);
      }
      if (this.spedRuntime && generation === this.generation) {
        this.settleSpedUnconfirmed(pair);
        await this.maybeSendSpedFallback(protocol, addr, generation);
      }
    };

    // The Binding Response replay cache is SPED state: without SPED a
    // request is answered as before, keeping nothing per transaction.
    if (spedBoundary) {
      const cachedResponse = this.cachedSpedBindingResponse(txHex);
      if (cachedResponse) {
        await replayCached(cachedResponse);
        return;
      }

      const inFlight = this.spedBindingCache.getInFlight(txHex);
      if (inFlight) {
        const ready = await inFlight;
        if (ready && this.generation === generation) {
          await replayCached(ready);
        }
        return;
      }
    }

    const finish = spedBoundary
      ? this.spedBindingCache.begin(txHex).finish
      : () => {};
    let result: Buffer | undefined;
    try {
      if (
        this.spedRuntime &&
        pair &&
        this.spedRuntime.isLiveGeneration(generation)
      ) {
        await this.spedRuntime.handleAuthenticatedStun(
          verified,
          addr,
          generation,
          pair,
        );
        if (generation !== this.generation) {
          return;
        }
        const raced = this.cachedSpedBindingResponse(txHex);
        if (raced) {
          result = raced;
          await replayCached(raced);
          return;
        }
      }

      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        verified.transactionId,
      );
      response.setAttribute("XOR-MAPPED-ADDRESS", addr);
      if (this.spedRuntime && pair) {
        if (!this.spedRuntime.decorateOutgoing(response, pair)) {
          return;
        }
      }
      response
        .addIntegrity(
          Buffer.from(localPassword, "utf8"),
          this.spedRuntime?.session.embedding
            ? "sha1"
            : responseIntegrityMode(verified),
        )
        .addFingerprint();
      if (spedBoundary) {
        const wire = Buffer.from(response.bytes);
        this.storeSpedBindingResponse(txHex, wire);
        result = wire;
      }
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });

      if (deferIncoming) {
        this.earlyChecks.push([verified, addr, protocol]);
      } else {
        this.checkIncoming(verified, addr, protocol);
      }

      if (this.spedRuntime && generation === this.generation) {
        this.settleSpedUnconfirmed(pair);
        await this.maybeSendSpedFallback(protocol, addr, generation);
      }
    } finally {
      finish(result);
    }
  }

  private shouldCacheSpedBindingResponse(): boolean {
    return this.spedRuntime?.session.embedding === true;
  }

  private cachedSpedBindingResponse(txHex: string): Buffer | undefined {
    if (!this.shouldCacheSpedBindingResponse()) {
      this.spedBindingCache.clearEntries();
      return undefined;
    }
    return this.spedBindingCache.get(txHex);
  }

  private storeSpedBindingResponse(txHex: string, bytes: Buffer): void {
    if (!this.shouldCacheSpedBindingResponse()) {
      this.spedBindingCache.clearEntries();
      return;
    }
    this.spedBindingCache.set(txHex, bytes, stunTransactionLifetimeMs());
  }

  /**
   * @internal
   * Handshake complete: drop Binding Response replay entries immediately
   * instead of waiting for the next Binding or TTL.
   */
  forgetSpedBindingResponseCache(): void {
    this.spedBindingCache.clearEntries();
  }

  /**
   * RFC 6544: the selected TCP connection is the only path for this component;
   * once it is closed no application data or consent check can reach the peer,
   * so fail the same way as a consent expiry instead of waiting for it.
   */
  private handleConnectionClosed(protocol: Protocol, remoteAddr: Address) {
    const nominated = this.nominated;
    if (
      !nominated ||
      nominated.protocol !== protocol ||
      nominated.remoteAddr[0] !== remoteAddr[0] ||
      nominated.remoteAddr[1] !== remoteAddr[1]
    ) {
      return;
    }
    if (this.state === "closed" || this.state === "failed") {
      return;
    }
    log("selected tcp connection closed", nominated.toJSON());
    this.consent.stop();
    this.setState("failed");
  }

  async connect() {
    // """
    // Perform ICE handshake.
    //
    // This coroutine returns if a candidate pair was successfully nominated
    // and raises an exception otherwise.
    // """
    log("start connect ice");
    if (!this.localCandidatesEnd) {
      if (!this.localCandidatesStart) {
        throw new Error("Local candidates gathering was not performed");
      }
    }
    if (!this.remoteUsername || !this.remotePassword) {
      throw new Error("Remote username or password is missing");
    }
    this.checksBegun = true;
    // The generation this connect() checks ends with restart(),
    // restartRemote() or close() (they abort `remoteChecks`). Every wait
    // below stops on `ended` and settles at once (connectError), and nothing
    // after it touches the state, check list or results (`checkListState`)
    // of the generation that replaced this one.
    const ended = this.remoteChecks.signal;
    const queue = this.checkListState;
    const untilEnded = this.untilEnded(ended);

    // # 5.7.1. Forming Candidate Pairs
    for (const c of this.remoteCandidates) {
      this.pairRemoteCandidate(c);
    }
    this.sortCheckList();

    if (!this.iceLite) {
      this.unfreezeInitial();
    }

    log("earlyChecks", this.localPassword, this.earlyChecks.length);
    // # handle early checks
    for (const earlyCheck of this.earlyChecks) {
      this.checkIncoming(...earlyCheck);
      const [, addr, protocol] = earlyCheck;
      this.settleSpedUnconfirmed(this.findPairByAddr(protocol, addr));
      await this.maybeSendSpedFallback(protocol, addr, this.generation);
    }
    this.earlyChecks = [];
    this.earlyChecksDone = true;
    // Arms the wait for a preferred pair even while the checklist is empty.
    this.nomination.evaluate();

    if (this.iceLite) {
      // An ICE-lite agent sends no checks: with no pair yet, only a check
      // from the peer (or a trickled candidate) can add one, and like a full
      // agent it waits `incomingCheckTimeout` for it.
      if (
        !this.nominated &&
        this.checkList.length === 0 &&
        !(await this.waitForIncomingCheck(ended))
      ) {
        if (ended.aborted) throw this.connectError();
        if (!this.nominated) throw new Error("ICE negotiation failed");
      }
      if (ended.aborted) throw this.connectError();
      if (!this.nominated) {
        let res: number = ICE_FAILED;
        while (!this.checkListDone) {
          res = await Promise.race([queue.get(), untilEnded]);
          if (ended.aborted) throw this.connectError();
          log("checkListState", res);
          if (res === ICE_COMPLETED) {
            break;
          }
        }

        if (res !== ICE_COMPLETED && !this.nominated) {
          if (this.state !== "closed") {
            this.setState("failed");
          }
          throw new Error("ICE negotiation failed");
        }
      }

      this.setState("connected");
      return;
    }

    // # perform checks
    // 5.8.  Scheduling Checks
    scheduling: for (;;) {
      for (;;) {
        // A restart resets `remoteCandidatesEnd`, so schedulingChecks()
        // would keep returning true and checking the new generation's pairs.
        if (ended.aborted) throw this.connectError();
        if (this.state === "closed") break scheduling;
        // A selection that may still be replaced: the checks of the pairs
        // that outrank it go on in `SelectionReplacement.checkOutrankingPairs`.
        if (this.nominated && this.iceControlling && this.replacesSelection()) {
          break scheduling;
        }
        if (!this.schedulingChecks()) break;
        await timers.setTimeout(20);
      }
      // No pair to check (the peer offered only active TCP candidates, or
      // none this agent can reach): a check from the peer can still add a
      // peer-reflexive pair, so the empty check list does not fail at once.
      const pairAdded = await this.waitForIncomingCheck(ended);
      if (ended.aborted) throw this.connectError();
      if (!pairAdded) break;
    }
    this.schedulingStopped = true;

    // # wait for completion
    let res: number = ICE_FAILED;
    // The nomination may still wait for a pair an incoming check forms
    // (`NominationHint`), even with an empty checklist.
    while (
      (this.checkList.length > 0 || this.nomination.waiting) &&
      res === ICE_FAILED
    ) {
      res = await Promise.race([queue.get(), untilEnded]);
      // Before cancelling "remaining checks": after a restart `checkList`
      // is the new generation's.
      if (ended.aborted) throw this.connectError();
      log("checkListState", res);
    }

    // # cancel remaining checks
    // (but those of pairs that may still replace the selection)
    const selected = this.nominated;
    const keepsChecking =
      !!selected && this.iceControlling && this.replacesSelection();
    for (const check of this.checkList) {
      if (
        keepsChecking &&
        this.replacesWith(check) &&
        this.outranks(check, selected)
      ) {
        continue;
      }
      check.handle?.resolve?.();
    }

    if (res !== ICE_COMPLETED && !this.nominated) {
      if (this.state !== "closed") {
        this.setState("failed");
      }
      throw new Error("ICE negotiation failed");
    }

    // # start consent freshness tests
    this.consent.start();

    this.setState("connected");
  }

  /**
   * The error connect() ends with when its generation ended: close() fails
   * it as before (`ICE negotiation failed`); a restart (local or
   * remote-only) cancels it with `IceRestartedError`, which says nothing
   * about the generation that replaced it.
   */
  private connectError() {
    if (this.closed) return new Error("ICE negotiation failed");
    log("connect of a replaced generation cancelled by an ICE restart");
    return new IceRestartedError();
  }

  /**
   * Resolves (with ICE_FAILED, which no caller acts on: each checks
   * `ended` first) once `ended` aborts, so a wait raced against it stops.
   */
  private untilEnded(ended: AbortSignal) {
    return new Promise<number>((resolve) => {
      if (ended.aborted) return resolve(ICE_FAILED);
      ended.addEventListener("abort", () => resolve(ICE_FAILED), {
        once: true,
      });
    });
  }

  /**
   * With an empty check list, wait for a pair (a check from the peer taught a
   * peer-reflexive candidate, RFC 8445 section 7.3.1.3, the only way to
   * connect to a peer whose TCP candidates are all active, RFC 6544; or a
   * trickled candidate). Resolves true when a pair was added, so that the
   * scheduling loop runs again; false when:
   * - the local gathering ended without a socket that could receive a check
   *   (at once, also when it ends during the wait: an ICE-lite agent may
   *   connect while it still gathers),
   * - `incomingCheckTimeout` ran out (a deadline fixed when the wait began;
   *   being woken does not extend it), or
   * - the generation ended (`ended`; the caller settles with connectError).
   * Every concurrent caller wakes on its own.
   */
  private async waitForIncomingCheck(ended: AbortSignal) {
    const seconds =
      this.options.incomingCheckTimeout ?? DEFAULT_INCOMING_CHECK_TIMEOUT;
    if (this.checkList.length > 0 || ended.aborted || !(seconds > 0)) {
      return false;
    }
    log("empty check list, waiting for an incoming check", seconds);
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      // Nothing local can receive a check, and gathering will not add one.
      if (this.protocols.length === 0 && this.localCandidatesEnd) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const wake = new AbortController();
      this.incomingCheckWaits.add(wake);
      try {
        await timers.setTimeout(remaining, undefined, {
          signal: AbortSignal.any([wake.signal, ended]),
        });
        return false;
      } catch {
        // Woken: a pair was added, the gathering ended, or the generation ended.
      } finally {
        this.incomingCheckWaits.delete(wake);
      }
      if (ended.aborted || this.closed) return false;
      if (this.checkList.length > 0) return true;
      // The gathering ended without a pair: check its sockets again.
    }
  }

  /** Wake every wait of connect() for an incoming check (waitForIncomingCheck). */
  private wakeIncomingCheckWaits() {
    for (const wait of this.incomingCheckWaits) wait.abort();
  }

  private unfreezeInitial() {
    // # unfreeze first pair for the first component
    const [firstPair] = this.checkList;
    if (!firstPair) return;
    if (firstPair.state === CandidatePairState.FROZEN) {
      firstPair.updateState(CandidatePairState.WAITING);
    }

    // # unfreeze pairs with same component but different foundations
    const seenFoundations = new Set(firstPair.localCandidate.foundation);
    for (const pair of this.checkList) {
      if (
        pair.component === firstPair.component &&
        !seenFoundations.has(pair.localCandidate.foundation) &&
        pair.state === CandidatePairState.FROZEN
      ) {
        pair.updateState(CandidatePairState.WAITING);
        seenFoundations.add(pair.localCandidate.foundation);
      }
    }
  }

  // 5.8 Scheduling Checks
  private schedulingChecks() {
    // Ordinary Check
    {
      // # find the highest-priority pair that is in the waiting state
      const pair = this.checkList
        .filter((pair) => {
          if (
            isRelayOnlyGathering(this.options) &&
            pair.protocol.type === StunProtocol.type
          )
            return false;
          return true;
        })
        .find((pair) => pair.state === CandidatePairState.WAITING);
      if (pair) {
        pair.handle = this.checkStart(pair);
        return true;
      }
    }

    {
      // # find the highest-priority pair that is in the frozen state
      const pair = this.checkList.find(
        (pair) => pair.state === CandidatePairState.FROZEN,
      );
      if (pair) {
        pair.handle = this.checkStart(pair);
        return true;
      }
    }

    // # if we expect more candidates, keep going: remote ones until
    // end-of-candidates, local ones until this generation's gathering ends
    // (a relay candidate of an ICE restart can follow the remote ones).
    if (!this.remoteCandidatesEnd || !this.localCandidatesEnd) {
      return !this.checkListDone;
    }

    return false;
  }

  /**
   * Mirror libwebrtc semi-aggressive nomination (not required by RFC 7675):
   * attach USE-CANDIDATE to consent checks of the selected pair when we are
   * controlling and the remote is ICE-lite, or we nominate semi-aggressively
   * (a peer that became controlled after a role conflict, or lost the
   * nominating response, learns the selection from them).
   */
  private shouldNominateConsentRequest(pair: CandidatePair): boolean {
    return (
      this.iceControlling &&
      this.nominated?.id === pair.id &&
      (this.remoteIsLite || this.usesSemiAggressiveNomination())
    );
  }

  /**
   * Renomination: the NOMINATION value consent checks of the selected pair
   * carry, so the peer keeps (or learns) the selection. A pair selected
   * without a renomination of this agent (the peer nominated it while this
   * agent was controlled) takes the next value.
   */
  private consentNomination(pair: CandidatePair) {
    if (!this.usesRenomination() || this.nominated?.id !== pair.id) {
      return undefined;
    }
    if (pair.nomination === 0)
      pair.nomination = this.selection.nextNominationValue();
    return pair.nomination;
  }

  private canSendApplicationData(): boolean {
    if (!this.nominated) {
      return false;
    }
    if (this.state === "closed" || this.state === "failed") {
      return false;
    }
    // Local ICE-lite does not run consent checks; full agents need fresh consent.
    if (this.iceLite) {
      return true;
    }
    return this.consent.fresh;
  }

  async close() {
    // """
    // Close the connection.
    // """

    this.closed = true;
    this.setState("closed");
    this.onIceCandidateError.complete();
    this.onIceServerReached.complete();
    this.closing.abort();
    this.cancelChecks();
    this.provisionalChecklist.end();
    // Before the first await: a pending mDNS lookup is cancelled here, so no
    // response arriving while the protocols close adds a remote candidate.
    this.lookup?.close?.();
    this.lookup = undefined;
    this.remoteResolutions.clear();

    // # stop consent freshness tests
    this.consent.stop();

    // # stop check list
    if (this.checkList && !this.checkListDone) {
      this.checkListState.put(
        new Promise((r) => {
          r(ICE_FAILED);
        }),
      );
    }

    this.nominated = undefined;
    this.liteNominating = false;
    this.nomination.reset();
    this.selection.abort();
    this.nominationHint = undefined;
    const pendingWildcards = [
      ...this.gatherer.wildcardProtocols.values(),
    ].filter((protocol) => !this.protocols.includes(protocol));
    this.gatherer.wildcardProtocols.clear();
    for (const protocol of [...this.protocols, ...pendingWildcards]) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];

    this.spedCarryEpoch++;
    this.spedCarryInFlight = false;
    this.spedCarryQueued = false;
    this.spedSolicitPeerCarry = false;
    this.spedBindingCache.clear();
    this.spedRuntime?.abort();
    this.spedRuntime = undefined;
  }

  private setState(state: IceState) {
    this.state = state;
    this.stateChanged.execute(state);
    if (state === "failed" || state === "closed") {
      this.spedRuntime?.abort();
    }
  }

  /**
   * Known constraint (as in develop): candidates are not deduplicated. A
   * description applied again in the same generation (BUNDLE split and
   * merge after an ICE restart) adds its candidates and pairs a second time,
   * until the next restart. Deduplicating here alone breaks the pairs a
   * provisional generation dropped and the repeated add rebuilds; a fix needs
   * the pairing and provisional lifecycle together.
   */
  async addRemoteCandidate(remoteCandidate: Candidate | undefined) {
    // """
    // Add a remote candidate or signal end-of-candidates.

    // To signal end-of-candidates, pass `None`.

    // :param remote_candidate: A :class:`Candidate` instance or `None`.
    // """

    // A closed agent takes no candidate (and opens no mDNS socket).
    if (this.closed) return;

    if (!remoteCandidate) {
      if (this.remoteCandidatesEnd || this.remoteCandidatesEndRequested) {
        return;
      }
      // Candidates that arrived before end-of-candidates finish first.
      this.remoteCandidatesEndRequested = true;
      if (this.remoteResolutions.size > 0) {
        const generation = this.remoteGeneration;
        await Promise.allSettled([...this.remoteResolutions]);
        if (this.remoteGeneration !== generation || this.closed) return;
      }
      this.remoteCandidatesEnd = true;
      this.nomination.evaluate();
      const settled = this.settleSpedUnconfirmed();
      await this.flushSpedUnconfirmedFallback(settled);
      return;
    }

    // RFC 8838: a completed generation takes no further candidates.
    if (this.remoteCandidatesEnd || this.remoteCandidatesEndRequested) {
      return;
    }

    if (remoteCandidate.host.includes(".local")) {
      const generation = this.remoteGeneration;
      try {
        if (!this.lookup) {
          this.lookup = new MdnsLookup();
        }
        const resolution = this.lookup.lookup(remoteCandidate.host);
        this.remoteResolutions.add(resolution);
        try {
          remoteCandidate.host = await resolution;
        } finally {
          this.remoteResolutions.delete(resolution);
        }
      } catch (error) {
        return;
      }
      // An ICE restart, completion or close while resolving ends this candidate's generation.
      if (
        this.remoteGeneration !== generation ||
        this.remoteCandidatesEnd ||
        this.closed
      )
        return;
    }

    try {
      validateRemoteCandidate(remoteCandidate);
    } catch (error) {
      return;
    }

    log("addRemoteCandidate", remoteCandidate);
    const adopted = this.adoptExistingPrflx(remoteCandidate);
    if (adopted) {
      this.pairRemoteCandidate(adopted);
      this.sortCheckList();
      const settled = this.settleSpedUnconfirmed();
      await this.flushSpedUnconfirmedFallback(settled);
      return;
    }
    this._remoteCandidates.push(remoteCandidate);

    this.pairRemoteCandidate(remoteCandidate);
    this.sortCheckList();
  }

  /**
   * Trickle may signal host/srflx/relay after the address was learned as
   * prflx. Reuse that Candidate so SPED eligibility follows the signaled type.
   */
  private adoptExistingPrflx(signaled: Candidate): Candidate | undefined {
    const existing = this._remoteCandidates.find(
      (candidate) =>
        candidate.type === "prflx" &&
        candidate.host === signaled.host &&
        candidate.port === signaled.port &&
        candidate.transport.toLowerCase() === signaled.transport.toLowerCase(),
    );
    if (!existing) {
      return undefined;
    }
    existing.type = signaled.type;
    existing.foundation = signaled.foundation;
    existing.priority = signaled.priority;
    existing.relatedAddress = signaled.relatedAddress;
    existing.relatedPort = signaled.relatedPort;
    existing.tcptype = signaled.tcptype;
    return existing;
  }

  send = async (data: Buffer) => {
    // RFC 7675: after consent expiry, do not send application data on the 5-tuple.
    if (!this.canSendApplicationData()) {
      return;
    }
    const activePair = this.nominated!;
    await activePair.protocol.sendData(data, activePair.remoteAddr);

    // Update statistics
    activePair.packetsSent++;
    activePair.bytesSent += data.length;
  };

  getDefaultCandidate() {
    const candidates = this.localCandidates.sort(
      (a, b) => a.priority - b.priority,
    );
    const [candidate] = candidates;
    return candidate;
  }

  // for test only
  set remoteCandidates(value: Candidate[]) {
    if (this.remoteCandidatesEnd)
      throw new Error("Cannot set remote candidates after end-of-candidates.");
    this._remoteCandidates = [];
    for (const remoteCandidate of value) {
      try {
        validateRemoteCandidate(remoteCandidate);
      } catch (error) {
        continue;
      }
      this._remoteCandidates.push(remoteCandidate);
    }

    this.remoteCandidatesEnd = true;
  }
  get remoteCandidates() {
    return this._remoteCandidates;
  }

  get candidatePairs() {
    return this.checkList;
  }

  private sortCheckList() {
    sortCandidatePairs(this.checkList, this.iceControlling);
  }

  private findPair(protocol: Protocol, remoteCandidate: Candidate) {
    const pair = this.checkList.find(
      (pair) =>
        pair.protocol === protocol && pair.remoteCandidate === remoteCandidate,
    );
    return pair;
  }

  private findPairByAddr(protocol: Protocol, addr: Address) {
    return this.checkList.find(
      (pair) =>
        pair.protocol === protocol &&
        pair.remoteAddr[0] === addr[0] &&
        pair.remoteAddr[1] === addr[1],
    );
  }

  /**
   * Datagrams map to a pair by protocol and remote 5-tuple.
   * Nominated is preferred only when the source matches that pair.
   */
  private resolveDatagramPair(
    protocol: Protocol,
    addr?: Address,
  ): CandidatePair | undefined {
    if (addr) {
      if (
        this.nominated?.protocol === protocol &&
        this.nominated.remoteAddr[0] === addr[0] &&
        this.nominated.remoteAddr[1] === addr[1]
      ) {
        return this.nominated;
      }
      return this.findPairByAddr(protocol, addr);
    }
    if (this.nominated?.protocol === protocol) {
      return this.nominated;
    }
    return this.checkList.find((candidate) => candidate.protocol === protocol);
  }

  private decorateSpedRequest(request: Message, pair: CandidatePair): boolean {
    return this.spedRuntime?.decorateOutgoing(request, pair) ?? true;
  }

  private isStaleConnectivityCheck(
    pair: CandidatePair,
    generation: number,
  ): boolean {
    if (generation !== this.generation) {
      return true;
    }
    // Restart clears the list. Unlisted pair in an empty list is a unit-test
    // checkStart, not a stale generation.
    if (this.checkList.length === 0) {
      return false;
    }
    return !this.checkList.includes(pair);
  }

  private abandonInFlightStunTransactions() {
    for (const protocol of this.protocols) {
      const transactions = (
        protocol as {
          transactions?: Record<string, { abandon?: () => void }>;
        }
      ).transactions;
      if (!transactions) {
        continue;
      }
      for (const transaction of Object.values(transactions)) {
        transaction.abandon?.();
      }
    }
  }

  private maybeFlushSpedCarry() {
    if (this.iceLite) {
      return;
    }
    if (this.spedIncomingStunDepth > 0) {
      this.spedCarryQueued = true;
      return;
    }
    if (this.isTerminalIceState()) {
      return;
    }
    void this.flushSpedCarry();
  }

  private isTerminalIceState() {
    const state = this.state as IceState;
    return state === "failed" || state === "closed";
  }

  /**
   * Send a Binding carrying current L1 when ICE checks will not
   * do so soon enough (e.g. Finished after aggressive nomination).
   * ICE-Lite never originates connectivity Binding Requests.
   */
  private async flushSpedCarry() {
    if (this.iceLite) {
      return;
    }
    if (this.isTerminalIceState()) {
      return;
    }
    const runtime = this.spedRuntime;
    if (!runtime?.session.embedding) {
      return;
    }
    if (this.spedCarryInFlight) {
      this.spedCarryQueued = true;
      return;
    }
    if (!runtime.session.hasL1 && !this.spedSolicitPeerCarry) {
      return;
    }
    if (!this.remoteUsername || !this.remotePassword) {
      return;
    }
    this.spedSolicitPeerCarry = false;

    const pair = this.selectSpedCarryPair(runtime);
    const protocol = pair?.protocol;
    const addr = pair?.remoteAddr;
    if (!pair || !protocol || !addr || !runtime.shouldDecorate(pair)) {
      return;
    }

    this.spedCarryInFlight = true;
    const generation = this.generation;
    const carryEpoch = this.spedCarryEpoch;
    let requestSucceeded = false;
    try {
      const request = this.buildRequest({
        nominate: false,
        localUsername: this.localUsername,
        remoteUsername: this.remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: pair.localCandidate,
      });
      if (!runtime.decorateOutgoing(request, pair)) {
        return;
      }
      const [response, responseAddr] = await protocol.request(
        request,
        addr,
        Buffer.from(this.remotePassword, "utf8"),
        this.isTcpPair(pair)
          ? {
              retransmissions: 0,
              responseTimeout: TCP_CHECK_RESPONSE_TIMEOUT_MS,
            }
          : { retransmissions: 2 },
      );
      if (
        generation !== this.generation ||
        carryEpoch !== this.spedCarryEpoch
      ) {
        return;
      }
      requestSucceeded = true;
      await this.consumeSpedStun(
        response,
        responseAddr,
        protocol,
        pair,
        generation,
      );
    } catch {
      // Loss is acceptable; connectivity checks / consent retry L1.
    } finally {
      this.spedCarryInFlight = false;
      const stale =
        carryEpoch !== this.spedCarryEpoch ||
        generation !== this.generation ||
        this.isTerminalIceState();
      if (!stale) {
        if (this.spedCarryQueued) {
          this.spedCarryQueued = false;
          void this.flushSpedCarry();
        } else if (
          requestSucceeded &&
          runtime.session.embedding &&
          runtime.session.hasL1
        ) {
          void this.flushSpedCarry();
        }
      }
    }
  }

  private selectSpedCarryPair(runtime: SpedRuntime): CandidatePair | undefined {
    if (runtime.lastPath && runtime.shouldDecorate(runtime.lastPath)) {
      return runtime.lastPath;
    }
    const ordered: CandidatePair[] = [];
    if (this.nominated) {
      ordered.push(this.nominated);
    }
    for (const candidate of this.checkList) {
      if (
        candidate.state === CandidatePairState.SUCCEEDED ||
        candidate.state === CandidatePairState.IN_PROGRESS
      ) {
        ordered.push(candidate);
      }
    }
    return ordered.find((candidate) => runtime.shouldDecorate(candidate));
  }

  private async consumeSpedStun(
    message: Message,
    addr: Address,
    protocol: Protocol,
    pair: CandidatePair | undefined,
    generation: number,
  ) {
    const runtime = this.spedRuntime;
    if (generation !== this.generation) {
      return;
    }
    if (!pair || !runtime || !runtime.isLiveGeneration(generation)) {
      return;
    }
    const result = await runtime.handleAuthenticatedStun(
      message,
      addr,
      generation,
      pair,
    );
    if (
      generation !== this.generation ||
      !runtime.isLiveGeneration(generation)
    ) {
      return;
    }
    if (pair) {
      runtime.syncRtt(pair);
    }
    if (result.inject) {
      this.spedSolicitPeerCarry = true;
      this.maybeFlushSpedCarry();
    }
    this.settleSpedUnconfirmed(pair);
    await this.maybeSendSpedFallback(protocol, addr, generation);
  }

  private applyIceControlling(iceControlling: boolean) {
    const becameControlling = !this._iceControlling && iceControlling;
    if (this._iceControlling !== iceControlling) {
      this.invalidateNominations();
      this.selection.clearRetries();
      // USE-CANDIDATE received while controlled came from a peer that was
      // controlling then; as the controlling agent this one nominates itself.
      if (iceControlling) {
        for (const pair of [
          ...this.checkList,
          ...(this.provisional?.pairs ?? []),
        ]) {
          pair.remoteNominated = false;
          pair.remoteNomination = 0;
        }
      }
    }
    this._iceControlling = iceControlling;
    for (const pair of this.checkList) {
      pair.iceControlling = iceControlling;
    }
    if (becameControlling) this.confirmSelections();
  }

  /**
   * The agent became controlling with a pair already selected (live or
   * provisional), e.g. one the peer nominated while this agent was
   * controlled. The selection stays (RFC 8445 §8.1.1 allows no other pair),
   * but the peer, controlled now, may still wait for a nomination: send
   * USE-CANDIDATE for that pair, repeated on timeouts as a nomination is.
   * A peer that selected the pair already keeps it.
   */
  private confirmSelections() {
    if (!this.nominatesFullPeer()) return;
    const live = this.nominated;
    if (live && this.state !== "closed" && this.checkList.includes(live)) {
      void this.confirmSelection(
        (signal) =>
          this.sendNomination(live, signal, this.consentNomination(live)),
        () => this.nominated === live && this.state !== "closed",
      );
    }
    const generation = this.provisional;
    const provisional = generation?.nominated;
    if (generation && provisional && generation.pairs.includes(provisional)) {
      void this.confirmSelection(
        (signal) =>
          this.provisionalChecklist.nominate(
            generation,
            provisional,
            AbortSignal.any([generation.checks.signal, signal]),
          ),
        () =>
          this.provisional === generation &&
          generation.nominated === provisional,
      );
    }
  }

  private async confirmSelection(
    send: (signal: AbortSignal) => Promise<NominationOutcome>,
    selected: () => boolean,
  ) {
    const abort = new AbortController();
    this.selectionConfirmations.add(abort);
    try {
      for (let attempt = 1; attempt <= NOMINATION_ATTEMPTS; attempt++) {
        const outcome = await send(abort.signal);
        if (abort.signal.aborted || !selected() || !this.iceControlling) {
          return;
        }
        if (outcome === "unanswered") continue;
        // 487: the peer is controlling and wins; it nominates.
        if (outcome === "role-conflict") this.switchRole(false);
        return;
      }
    } catch (error) {
      log("confirm selection failed", error);
    } finally {
      this.selectionConfirmations.delete(abort);
    }
  }

  /**
   * The role changed: a nomination in flight (live or provisional) was sent
   * as the controlling agent and must not select a pair, fail one, or fail
   * the agent under the new role. Its transaction stops; a controlling agent
   * later nominates afresh.
   */
  private invalidateNominations() {
    this.liteNominating = false;
    this.nomination.invalidate();
    this.selection.abort();
    for (const abort of this.selectionConfirmations) abort.abort();
    this.selectionConfirmations.clear();
    if (this.provisional) {
      this.provisional.liteNominating = false;
      this.provisional.nomination.invalidate();
    }
  }

  private switchRole(iceControlling: boolean) {
    log("switch role", iceControlling);
    // Role conflicts must be repaired even after a prior generation or while
    // connectivity checks are in flight (RFC 8445 §7.2.5.1 / §7.3.1.1).
    if (this.iceLite) {
      iceControlling = false;
    }
    this.applyIceControlling(iceControlling);
    this.sortCheckList();
    // Only a controlling agent nominates: start (or stop) waiting for it.
    this.nomination.evaluate();
    this.provisional?.nomination.evaluate();
    this.selection.evaluate();
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      const settled = this.settleSpedUnconfirmed(pair);
      void this.flushSpedUnconfirmedFallback(settled ?? pair);
      this.selection.forgetRetry(pair);
      // Updating the Nominated Flag

      // https://www.rfc-editor.org/rfc/rfc8445#section-7.3.1.5,
      // Once the nominated flag is set for a component of a data stream, it
      // concludes the ICE processing for that component.  See Section 8.
      // So disallow overwriting of the pair nominated for that component
      if (
        pair.nominated &&
        // The pair belongs to the live remote generation: it is in the
        // current checklist (a restart resets it, so a check still in flight
        // from a discarded generation cannot select its pair) and its remote
        // candidate names the live remote ufrag, if it names one. The SDP
        // `generation` attribute counts the peer's own restarts and is not
        // comparable with the local generation (a remote-only restart, or a
        // peer that numbers differently).
        this.checkList.includes(pair) &&
        (pair.remoteCandidate.ufrag == undefined ||
          pair.remoteCandidate.ufrag === this.remoteUsername) &&
        // One selection, except that semi-aggressive nomination and
        // renomination replace it with a better nominated pair
        // (`SelectionReplacement.replaces`).
        (this.nominated == undefined || this.selection.replaces(pair))
      ) {
        const previous = this.nominated;
        log(previous ? "selected pair replaced" : "nominated", pair.toJSON(), {
          previous: previous?.toJSON(),
        });
        this.nominated = pair;
        this.liteNominating = false;
        this.nomination.stop();
        // RFC 7675 section 5.1: the successful connectivity check that
        // selected the pair is its initial consent, so data may flow at once
        // instead of waiting for the consent lifecycle to start.
        this.consent.fresh = true;
        this.pruneTcpConnections(pair);

        // After resetNominatedPair / renomination while already connected,
        // restart consent freshness on the new selected pair.
        if (
          !this.iceLite &&
          (this.state === "connected" || this.state === "completed")
        ) {
          this.consent.start();
        }

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream. A controlling agent that
        // may replace the selection keeps the pairs that outrank it.
        const keepsChecking = this.iceControlling && this.replacesSelection();
        for (const p of this.checkList) {
          if (
            p.component === pair.component &&
            (
              [
                CandidatePairState.WAITING,
                CandidatePairState.FROZEN,
              ] as CandidatePairState[]
            ).includes(p.state) &&
            !(keepsChecking && this.replacesWith(p) && this.outranks(p, pair))
          ) {
            p.updateState(CandidatePairState.FAILED);
          }
        }
      }

      // Once there is at least one nominated pair in the valid list for
      // every component of at least one media stream and the state of the
      // check list is Running:
      if (this.nominated) {
        if (!this.checkListDone) {
          log("ICE completed");
          this.checkListState.put(new Promise((r) => r(ICE_COMPLETED)));
          this.checkListDone = true;
        }
        if (this.iceControlling && this.replacesSelection()) {
          this.selection.evaluate();
          void this.selection.checkOutrankingPairs();
          this.selection.scheduleRetries();
        }
        return;
      }

      log("not completed", pair.toJSON());

      // 7.1.3.2.3.  Updating Pair States
      for (const p of this.checkList) {
        if (
          p.localCandidate.foundation === pair.localCandidate.foundation &&
          p.state === CandidatePairState.FROZEN
        ) {
          p.updateState(CandidatePairState.WAITING);
        }
      }
    }

    this.nomination.evaluate();
    this.selection.evaluate();
    this.selection.scheduleRetries();

    this.concludeCheckListIfExhausted();
  }

  /**
   * Fail the check list once no pair can succeed and no nomination can still
   * select one. Background gathering and remote trickle both delay this.
   */
  private concludeCheckListIfExhausted() {
    if (
      this.nominated ||
      this.liteNominating ||
      this.selection.nominating ||
      this.nomination.inFlight ||
      this.nomination.waiting
    ) {
      return;
    }

    {
      const list: CandidatePairState[] = [
        CandidatePairState.SUCCEEDED,
        CandidatePairState.FAILED,
      ];
      if (this.checkList.find(({ state }) => !list.includes(state))) {
        return;
      }
    }

    if (!this.iceControlling) {
      const target = CandidatePairState.SUCCEEDED;
      if (this.checkList.find(({ state }) => state === target)) {
        return;
      }
    }

    // RFC 8838 §8: with trickle ICE the check list fails only once neither
    // side can add candidates any more; a relay candidate still being gathered
    // (or a remote one before end-of-candidates) may yet pair and succeed.
    if (
      !this.checkListDone &&
      this.localCandidatesEnd &&
      this.remoteCandidatesEnd
    ) {
      log("ICE failed");
      this.checkListState.put(
        new Promise((r) => {
          r(ICE_FAILED);
        }),
      );
    }
  }

  // 3.  Terminology : Check
  checkStart = (pair: CandidatePair) =>
    cancelable<void>(async (r, _f, onCancel) => {
      // """
      // Starts a check.
      // """

      log("check start", pair.toJSON());
      // Resolving the handle (the checklist completed or was replaced) stops
      // the request's retransmissions too.
      const checks = new AbortController();
      onCancel.once(() => checks.abort());
      // The remote generation ending (restart / close) stops it as well.
      const signal = AbortSignal.any([checks.signal, this.remoteChecks.signal]);
      const remoteGeneration = this.remoteGeneration;

      pair.updateState(CandidatePairState.IN_PROGRESS);
      const result: { response?: Message; addr?: Address } = {};
      const { remotePassword, remoteUsername, generation } = this;
      const localUsername = pair.localCandidate.ufrag ?? this.localUsername;
      const stopIfStale = () => {
        if (!this.isStaleConnectivityCheck(pair, generation)) {
          return false;
        }
        r();
        return true;
      };

      // Semi-aggressive nomination: USE-CANDIDATE while nothing is selected
      // and for a pair that outranks the selected one. Regular nomination
      // (RegularNomination) and renomination (`SelectionReplacement.evaluate`) nominate
      // with a separate check; an ordinary check carries nothing.
      const nominate =
        this.usesSemiAggressiveNomination() &&
        this.replacesWith(pair) &&
        (!this.nominated || this.outranks(pair, this.nominated));
      const request = this.buildRequest({
        nominate,
        localUsername,
        remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: pair.localCandidate,
      });
      if (!this.decorateSpedRequest(request, pair)) {
        if (stopIfStale()) {
          return;
        }
        pair.updateState(CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // Record start time for RTT calculation
      const startTime = performance.now();

      try {
        pair.requestsSent++;
        const [response, addr] = await pair.protocol.request(
          request,
          pair.remoteAddr,
          Buffer.from(remotePassword, "utf8"),
          { ...this.checkRequestOptions(pair), signal },
        );
        if (stopIfStale()) {
          return;
        }
        pair.responsesReceived++;

        // Calculate RTT
        const endTime = performance.now();
        const rtt = (endTime - startTime) / 1000; // Convert to seconds

        // Update RTT statistics
        pair.rtt = rtt;
        pair.totalRoundTripTime += rtt;
        pair.roundTripTimeMeasurements++;

        log("response received", request.toJSON(), response.toJSON(), addr, {
          localUsername,
          remoteUsername,
          remotePassword,
          generation,
          rtt,
        });
        result.response = response;
        result.addr = addr;
        await this.consumeSpedStun(
          response,
          addr,
          pair.protocol,
          pair,
          generation,
        );
        if (stopIfStale()) {
          return;
        }
      } catch (error: any) {
        // A cancelled check (its handle resolved, or the agent closed and
        // cancelled its transactions) changes nothing.
        if (signal.aborted || error instanceof TransactionCancelled) {
          this.checkCancelled(pair, remoteGeneration);
          r();
          return;
        }
        if (stopIfStale()) {
          return;
        }
        const exc: TransactionError = error;
        // 7.1.3.1.  Failure Cases
        log(
          "failure case",
          request.toJSON(),
          exc.response ? JSON.stringify(exc.response.toJSON(), null, 2) : error,
          {
            localUsername,
            remoteUsername,
            remotePassword,
            generation,
          },
          pair.remoteAddr,
        );
        if (exc.response?.getAttributeValue("ERROR-CODE")[0] === 487) {
          if (request.attributesKeys.includes("ICE-CONTROLLED")) {
            this.switchRole(true);
          } else if (request.attributesKeys.includes("ICE-CONTROLLING")) {
            this.switchRole(false);
          }
          await this.retryCheck(pair, onCancel);
          r();
          return;
        }
        if (exc.response?.getAttributeValue("ERROR-CODE")[0] === 401) {
          log("retry 401", pair.toJSON());
          await this.retryCheck(pair, onCancel);
          r();
          return;
        } else {
          // timeout
          log("checkStart CandidatePairState.FAILED", pair.toJSON());
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
      }

      if (stopIfStale()) {
        return;
      }

      // # check remote address matches
      if (
        result.addr[0] !== pair.remoteAddr[0] ||
        result.addr[1] !== pair.remoteAddr[1]
      ) {
        pair.updateState(CandidatePairState.FAILED);
        this.checkComplete(pair);
        r();
        return;
      }

      // # success
      // The peer's USE-CANDIDATE selects the pair only while this agent is
      // controlled: one received before a role switch made it controlling is
      // not a nomination any more (the peer is controlled now and waits for
      // this agent's USE-CANDIDATE), so it nominates by itself below.
      if (pair.remoteNominated && !this.iceControlling) {
        // # nominated by the remote party
        pair.nominated = true;
      } else if (
        this.iceControlling &&
        this.remoteIsLite &&
        !this.liteNominating
      ) {
        // # ICE-lite peer: nominate the first pair that succeeds
        this.liteNominating = true;
        const request = this.buildRequest({
          nominate: true,
          localUsername,
          remoteUsername,
          iceControlling: this.iceControlling,
          localCandidate: pair.localCandidate,
        });
        if (!this.decorateSpedRequest(request, pair)) {
          if (stopIfStale()) {
            return;
          }
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
        try {
          pair.requestsSent++;
          const [nomResponse, nomAddr] = await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8"),
            { ...this.checkRequestOptions(pair), signal },
          );
          if (stopIfStale()) {
            return;
          }
          pair.responsesReceived++;
          await this.consumeSpedStun(
            nomResponse,
            nomAddr,
            pair.protocol,
            pair,
            generation,
          );
          if (stopIfStale()) {
            return;
          }
        } catch (error) {
          // A nomination of a generation that ended (or a cancelled check)
          // must not touch the state of the generation that replaced it.
          if (
            signal.aborted ||
            error instanceof TransactionCancelled ||
            this.isStaleNomination(pair, remoteGeneration)
          ) {
            r();
            return;
          }
          this.liteNominating = false;
          if (stopIfStale()) {
            return;
          }
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }
        if (this.isStaleNomination(pair, remoteGeneration)) {
          r();
          return;
        }
        if (stopIfStale()) {
          return;
        }
        pair.nominated = true;
      } else if (
        nominate &&
        this.iceControlling &&
        this.remoteGeneration === remoteGeneration
      ) {
        // # semi-aggressive: the check that succeeded carried USE-CANDIDATE
        pair.nominated = true;
      }

      pair.updateState(CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

  /**
   * A check of the live checklist cancelled before its outcome (the
   * checklist completed, `connect` cancels the remaining checks) leaves the
   * pair Waiting instead of In-Progress, so the peer's checks on it still
   * trigger one (7.2.1.4): a controlled agent that selected a lower pair can
   * then follow a later nomination of this one. A nomination already received
   * for it is checked at once (its triggering check came while the cancelled
   * one was still in flight). A generation that ended or a closed agent
   * changes nothing.
   */
  private checkCancelled(pair: CandidatePair, remoteGeneration: number) {
    if (
      pair.state !== CandidatePairState.IN_PROGRESS ||
      this.state === "closed" ||
      this.remoteGeneration !== remoteGeneration ||
      !this.checkList.includes(pair)
    ) {
      return;
    }
    pair.updateState(CandidatePairState.WAITING);
    if (pair.remoteNominated && !this.iceControlling) {
      pair.handle = this.checkStart(pair);
    }
  }

  /**
   * 487 / 401 retry of a check: the retry is cancelled with the check it
   * replaces (its handle) and, through checkStart, with the generation.
   */
  private async retryCheck(pair: CandidatePair, onCancel: Event<[any]>) {
    const retry = this.checkStart(pair);
    onCancel.once(() => retry.resolve());
    await retry.awaitable;
  }

  private isTcpPair(pair: CandidatePair) {
    return pair.localCandidate.transport.toLowerCase() === "tcp";
  }

  private checkRequestOptions(pair: CandidatePair): TransactionRequestOptions {
    const onRequestSent = (attempt: number) => {
      if (attempt > 0) {
        pair.retransmissionsSent++;
      }
    };
    const integrityAlgorithm = this.options.messageIntegrity;
    if (this.isTcpPair(pair)) {
      // RFC 5389 §7.2.2: no retransmissions over a reliable transport.
      return {
        retransmissions: 0,
        responseTimeout: TCP_CHECK_RESPONSE_TIMEOUT_MS,
        onRequestSent,
        integrityAlgorithm,
      };
    }
    return { retransmissions: 4, onRequestSent, integrityAlgorithm };
  }

  /** The agent is controlling and both agents are full ICE. */
  private nominatesFullPeer() {
    return this.iceControlling && !this.remoteIsLite && !this.iceLite;
  }

  /**
   * Both agents advertised renomination (`IceOptions.renomination`): the
   * controlling agent nominates with NOMINATION values instead of
   * USE-CANDIDATE, whatever `IceOptions.nomination` says.
   */
  private usesRenomination() {
    return (
      this.nominatesFullPeer() &&
      !!this.options.renomination &&
      this.remoteRenomination
    );
  }

  /**
   * `nomination: "regular"`: RFC 8445 §8.1.1 regular nomination for every
   * transport. A check that succeeds only makes its pair valid;
   * `RegularNomination` later picks one valid pair and nominates it once
   * with a separate USE-CANDIDATE check.
   */
  private usesRegularNomination() {
    return (
      this.nominatesFullPeer() &&
      this.options.nomination === "regular" &&
      !this.usesRenomination()
    );
  }

  /**
   * The default, as libwebrtc: checks carry USE-CANDIDATE until a pair is
   * selected and afterwards for pairs that outrank the selected one, so the
   * first pair that succeeds is selected at once and a higher-priority pair
   * that succeeds later (a TURN/UDP candidate trickled after a TURN/TCP one
   * connected) replaces it. A first-success-wins nomination would keep the
   * lower-priority pair for the whole session.
   */
  private usesSemiAggressiveNomination() {
    return (
      this.nominatesFullPeer() &&
      this.options.nomination !== "regular" &&
      !this.usesRenomination()
    );
  }

  /**
   * The controlling agent may move the selection to a higher-priority pair
   * (semi-aggressive nomination, renomination): checks of pairs that outrank
   * the selected one go on after the first selection.
   */
  private replacesSelection() {
    return this.usesSemiAggressiveNomination() || this.usesRenomination();
  }

  /**
   * A pair semi-aggressive nomination and renomination may select: not an
   * ICE-TCP pair (each TCP pair is its own connection, and nominating more
   * than one could leave the agents on different connections after pruning;
   * TCP pairs keep regular nomination, see `regularNominationPairs`), nor
   * one the agent never checks (forceTurn).
   */
  private replacesWith(pair: CandidatePair) {
    return !this.isTcpPair(pair) && !this.isUncheckedPair(pair);
  }

  /**
   * The pairs `RegularNomination` nominates from: every pair with
   * `nomination: "regular"`, otherwise the ICE-TCP pairs (as before
   * semi-aggressive nomination, #721).
   */
  private regularNominationPairs(pairs: readonly CandidatePair[]) {
    return this.usesRegularNomination()
      ? pairs
      : pairs.filter((pair) => this.isTcpPair(pair));
  }

  /** `IceOptions.nominationDelayMs`, or its default when unset or invalid. */
  private get nominationDelayMs() {
    const delay = this.options.nominationDelayMs;
    return delay !== undefined && Number.isFinite(delay) && delay >= 0
      ? delay
      : DEFAULT_NOMINATION_DELAY_MS;
  }

  /** A pair the agent never checks itself (forceTurn keeps it from the schedule). */
  private isUncheckedPair(pair: CandidatePair) {
    return !!this.options.forceTurn && pair.protocol.type === StunProtocol.type;
  }

  /** The highest-priority valid pair of `pairs`. */
  private bestValidPair(pairs: CandidatePair[]) {
    let best: CandidatePair | undefined;
    for (const pair of pairs) {
      if (
        pair.state === CandidatePairState.SUCCEEDED &&
        (!best || this.outranks(pair, best))
      ) {
        best = pair;
      }
    }
    return best;
  }

  private outranks(pair: CandidatePair, other: CandidatePair) {
    return (
      compareCandidatePairPriority(
        pair.localCandidate,
        pair.remoteCandidate,
        other.localCandidate,
        other.remoteCandidate,
        this.iceControlling,
      ) > 0
    );
  }

  /**
   * The live checklist's side of regular nomination (`RegularNomination`):
   * the controlling agent nominates the best valid pair once the checklist
   * is quiet (see `decideNomination`).
   */
  private liveNominationHost(): NominationHost {
    return {
      active: () =>
        this.nominatesFullPeer() && !this.nominated && this.state !== "closed",
      checking: () => this.checksBegun,
      pairs: () => this.regularNominationPairs(this.checkList),
      remoteCandidatesEnd: () => this.remoteCandidatesEnd,
      localCandidatesEnd: () => this.localCandidatesEnd,
      delayMs: () => this.nominationDelayMs,
      unchecked: (pair) => this.isUncheckedPair(pair),
      outranks: (pair, other) => this.outranks(pair, other),
      preferred: () => {
        const hint = this.nominationHint;
        if (
          !hint ||
          // Semi-aggressive nomination and renomination may replace the
          // selection; the hint belongs to regular nomination.
          !this.usesRegularNomination() ||
          hint.localUsername !== this.localUsername ||
          hint.remoteUsername !== this.remoteUsername ||
          hint.remotePassword !== this.remotePassword ||
          // The commit closed the pair's socket (a TURN allocation an ICE
          // restart replaces, an excluded host socket): the path is gone for
          // the peer too, so the usual rules choose.
          !this.protocols.includes(hint.protocol)
        ) {
          return undefined;
        }
        return (pair) => pairKey(pair) === hint.key;
      },
      owns: (pair) => this.state !== "closed" && this.checkList.includes(pair),
      send: (pair, signal) => this.sendNomination(pair, signal),
      nominated: (pair) => {
        pair.nominated = true;
        this.checkComplete(pair);
      },
      rejected: (pair) => {
        // The peer did not select this pair: only it fails, and
        // checkComplete nominates the next one.
        pair.updateState(CandidatePairState.FAILED);
        this.checkComplete(pair);
      },
      // RFC 8445 §7.2.5.1: the peer is controlling too and wins; the
      // nomination was not accepted. Become controlled: the pair stays
      // valid and the peer nominates.
      roleConflict: () => this.switchRole(false),
      abandoned: (pair) => this.nominationAbandoned(pair),
      // The valid pair it waited for may be gone (another remote generation
      // dropped): the checklist may have failed meanwhile.
      deadlinePassed: () => this.concludeCheckListIfExhausted(),
    };
  }

  /**
   * Send the USE-CANDIDATE check for a live `pair` (see `NominationOutcome`),
   * or with `nomination` the renomination check that carries that
   * NOMINATION value instead.
   */
  private async sendNomination(
    pair: CandidatePair,
    signal: AbortSignal,
    nomination?: number,
  ): Promise<NominationOutcome> {
    const request = this.buildRequest({
      nominate: nomination === undefined,
      nomination,
      localUsername: pair.localCandidate.ufrag ?? this.localUsername,
      remoteUsername: this.remoteUsername,
      iceControlling: this.iceControlling,
      localCandidate: pair.localCandidate,
    });
    if (!this.decorateSpedRequest(request, pair)) {
      return "rejected";
    }
    const generation = this.generation;
    pair.requestsSent++;
    try {
      const [response, addr] = await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(this.remotePassword, "utf8"),
        {
          ...this.checkRequestOptions(pair),
          signal: AbortSignal.any([this.remoteChecks.signal, signal]),
        },
      );
      pair.responsesReceived++;
      await this.consumeSpedStun(
        response,
        addr,
        pair.protocol,
        pair,
        generation,
      );
      return "nominated";
    } catch (error) {
      log("nomination failed", pair.toJSON(), error);
      if (isRoleConflict(error)) return "role-conflict";
      return error instanceof TransactionTimeout ? "unanswered" : "rejected";
    }
  }

  /**
   * No attempt of a USE-CANDIDATE check was answered, or the pair a
   * provisional nomination may have selected (`NominationHint`) failed or
   * never appeared. A request may still have reached the peer, and a
   * controlled agent keeps the first pair
   * nominated to it (RFC 8445 §8.1.1): nominating another pair could leave
   * the two agents on different pairs. The agent nominates nothing else,
   * connect() rejects and the agent fails (an ICE restart starts over), as a
   * consent expiry does.
   */
  private nominationAbandoned(pair?: CandidatePair) {
    pair?.updateState(CandidatePairState.FAILED);
    if (!this.checkListDone) {
      this.checkListDone = true;
      this.checkListState.put(new Promise((r) => r(ICE_NOMINATION_ABANDONED)));
    }
    this.setState("failed");
  }

  /**
   * At the restart that ends the provisional checklist (a final answer): the
   * pair it nominated, or sent a USE-CANDIDATE to that the peer did not
   * refuse (see `NominationHint`).
   */
  private provisionalNominationHint(): NominationHint | undefined {
    const generation = this.provisional;
    const pair = generation?.nominated ?? generation?.nomination.maybeSelected;
    if (!generation?.remoteUsername || !generation.remotePassword || !pair) {
      return undefined;
    }
    return {
      localUsername: generation.localUsername,
      remoteUsername: generation.remoteUsername,
      remotePassword: generation.remotePassword,
      key: pairKey(pair),
      protocol: pair.protocol,
    };
  }

  /** The agent was closed or restarted while the ICE-lite nomination was in flight. */
  private isStaleNomination(pair: CandidatePair, generation: number) {
    return (
      this.state === "closed" ||
      this.remoteGeneration !== generation ||
      !this.checkList.includes(pair)
    );
  }

  private addPair(pair: CandidatePair) {
    const best = this.bestValidPair(this.checkList);
    this.checkList.push(pair);
    this.sortCheckList();
    this.wakeIncomingCheckWaits();
    this.nomination.pairAdded(pair, best);
    // A pair that may replace the selection is checked after it too.
    const selected = this.nominated;
    if (
      selected &&
      this.iceControlling &&
      this.replacesSelection() &&
      this.replacesWith(pair) &&
      this.outranks(pair, selected)
    ) {
      void this.selection.checkOutrankingPairs();
    }
  }

  private ensureIncomingPair(
    message: Message,
    addr: Address,
    protocol: Protocol,
  ): CandidatePair {
    const txUsername = message.getAttributeValue("USERNAME");
    const { remoteUsername: localUsername } = decodeTxUsername(txUsername);

    let remoteCandidate: Candidate | undefined;
    const [host, port] = addr;
    for (const c of this.remoteCandidates) {
      if (c.host === host && c.port === port) {
        remoteCandidate = c;
        break;
      }
    }
    if (!remoteCandidate && isConnectionSpedEnabled(this)) {
      // SPED: a pair of this protocol and remote address exists already (its
      // candidate is no longer listed). The check belongs to it: a second
      // pair of the same 5-tuple would split the authenticated path SPED
      // pins. Without SPED a new peer-reflexive pair is formed as before.
      const existing = this.findPairByAddr(protocol, addr);
      if (existing) {
        return existing;
      }
    }
    if (!remoteCandidate) {
      remoteCandidate = new Candidate(
        randomString(10),
        1,
        protocol.localCandidate?.transport ?? "udp",
        message.getAttributeValue("PRIORITY"),
        host,
        port,
        "prflx",
        undefined,
        undefined,
        protocol.localCandidate?.transport === "tcp"
          ? remoteTcpTypeForIncoming(protocol.localCandidate.tcptype)
          : undefined,
        undefined,
        undefined,
      );
      this._remoteCandidates.push(remoteCandidate);
    }

    let pair = this.findPair(protocol, remoteCandidate);
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate, this.iceControlling);
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
    return pair;
  }

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: Protocol) {
    // """
    // Handle a successful incoming check.
    // """

    const pair = this.ensureIncomingPair(message, addr, protocol);
    pair.noteIncomingRequest(message.transactionIdHex);
    pair.requestsReceived++;
    pair.responsesSent++;
    // The pair's local candidate is the protocol's shared candidate of the
    // current generation. A late check addressed to an earlier ufrag (consent
    // on the old pair during an ICE restart) must not relabel it, or the next
    // description would advertise it under that old ufrag.

    log("Triggered Checks", message.toJSON(), pair.toJSON(), {
      localUsername: this.localUsername,
      remoteUsername: this.remoteUsername,
      localPassword: this.localPassword,
      remotePassword: this.remotePassword,
      generation: this.generation,
    });

    const nomination = receivedNomination(message);
    if (nomination > 0 && !this.iceControlling) {
      // We don't un-nominate a pair: keep the larger nomination.
      pair.remoteNomination = Math.max(pair.remoteNomination, nomination);
    }

    if (this.iceLite) {
      if (nomination > 0 && !this.iceControlling) {
        pair.remoteNominated = true;
        pair.nominated = true;
        pair.updateState(CandidatePairState.SUCCEEDED);
        this.checkComplete(pair);
      }
      return;
    }

    // 7.2.1.4.  Triggered Checks
    if (
      (
        [
          CandidatePairState.WAITING,
          CandidatePairState.FAILED,
        ] as CandidatePairState[]
      ).includes(pair.state)
    ) {
      pair.handle = this.checkStart(pair);
    }

    // 7.2.1.5. Updating the Nominated Flag
    // (USE-CANDIDATE, or a NOMINATION value with renomination; a pair
    // already selected may be replaced, see `SelectionReplacement.replaces`)
    if (nomination > 0 && !this.iceControlling) {
      pair.remoteNominated = true;
      if (pair.state === CandidatePairState.SUCCEEDED) {
        pair.nominated = true;
        this.checkComplete(pair);
      }
    }
  }

  /**
   * @param admit after a selection that may still be replaced, only pairs
   *   that could replace it join the checklist.
   */
  private tryPair(
    protocol: Protocol,
    remoteCandidate: Candidate,
    admit = this.admitsPair(),
    routeChecked = false,
  ) {
    if (!routeChecked && this.gatherer.isWildcardProtocol(protocol)) {
      void this.gatherer
        .wildcardPathUncovered(remoteCandidate)
        .then((uncovered) => {
          // As pairLocalProtocol: once a pair is selected (which also ends
          // the checklist) only a selection that may still be replaced
          // takes more pairs.
          const replaceable =
            !!this.nominated && this.iceControlling && this.replacesSelection();
          if (
            uncovered &&
            ((!this.nominated && !this.checkListDone) || replaceable) &&
            this.state !== "closed" &&
            this.protocols.includes(protocol) &&
            this.remoteCandidates.includes(remoteCandidate)
          ) {
            this.tryPair(protocol, remoteCandidate, this.admitsPair(), true);
            this.sortCheckList();
            const pair = this.findPair(protocol, remoteCandidate);
            if (
              this.schedulingStopped &&
              pair?.state === CandidatePairState.WAITING
            ) {
              pair.handle = this.checkStart(pair);
            }
          }
        });
      return;
    }
    if (
      protocol.localCandidate?.canPairWith(remoteCandidate) &&
      !(
        protocol.localCandidate.transport.toLowerCase() === "tcp" &&
        protocol.localCandidate.tcptype === "passive" &&
        remoteCandidate.type !== "prflx"
      ) &&
      !this.findPair(protocol, remoteCandidate)
    ) {
      const pair = new CandidatePair(
        protocol,
        remoteCandidate,
        this.iceControlling,
      );
      if (
        this.options.filterCandidatePair &&
        !this.options.filterCandidatePair(pair)
      ) {
        return;
      }
      if (admit && !admit(pair)) return;
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
  }

  /** See `tryPair`: undefined admits every pair. */
  private admitsPair(): ((pair: CandidatePair) => boolean) | undefined {
    const selected = this.nominated;
    if (!selected || !this.iceControlling || !this.replacesSelection()) {
      return undefined;
    }
    return (pair) => this.replacesWith(pair) && this.outranks(pair, selected);
  }

  /**
   * Pair a local candidate gathered after remote candidates arrived (a late
   * TURN allocation, a slow host socket) with them.
   */
  private pairLocalProtocol(protocol: Protocol) {
    // RFC 8445 §8.1.2: once a pair is selected, the check list takes no more
    // Waiting pairs, so a candidate gathered later starts no check. A
    // selection that may still be replaced (semi-aggressive nomination,
    // renomination) takes them: a late TURN/UDP allocation may outrank a
    // TURN/TCP pair selected before it.
    if (this.state === "closed") return;
    const replaceable =
      !!this.nominated && this.iceControlling && this.replacesSelection();
    if ((this.nominated || this.checkListDone) && !replaceable) {
      return;
    }
    for (const remoteCandidate of this.remoteCandidates) {
      this.tryPair(protocol, remoteCandidate);
    }
  }

  private pairRemoteCandidate = (remoteCandidate: Candidate) => {
    for (const protocol of this.protocols) {
      this.tryPair(protocol, remoteCandidate);
    }
  };

  /** A connectivity check from this agent (`buildCheckRequest`). */
  private buildRequest(params: Omit<CheckRequestParams, "tieBreaker">) {
    return buildCheckRequest({ ...params, tieBreaker: this.tieBreaker });
  }

  private pruneTcpConnections(selectedPair: CandidatePair) {
    for (const protocol of this.protocols) {
      if (protocol.localCandidate?.transport.toLowerCase() !== "tcp") {
        continue;
      }

      if (
        "pruneForSelection" in protocol &&
        typeof protocol.pruneForSelection === "function"
      ) {
        void protocol.pruneForSelection(
          protocol === selectedPair.protocol
            ? selectedPair.remoteAddr
            : undefined,
        );
      }
    }
  }

  private respondError(
    request: Message,
    addr: Address,
    protocol: Protocol,
    errorCode: [number, string],
    /**
     * The password of the local ufrag the request is addressed to: a check
     * for a staged (provisional) generation is verified with its password.
     */
    localPassword = this.localPassword,
  ) {
    const response = new Message(
      request.messageMethod,
      classes.ERROR,
      request.transactionId,
    );
    response
      .setAttribute("ERROR-CODE", errorCode)
      .addIntegrity(
        Buffer.from(localPassword, "utf8"),
        responseIntegrityMode(request),
      )
      .addFingerprint();
    protocol.sendStun(response, addr).catch((e) => {
      log("sendStun error", e);
    });
  }
}
