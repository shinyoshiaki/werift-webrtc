import * as timers from "node:timers/promises";
import { randomBytes } from "crypto";
import { isIPv4 } from "net";
import {
  Candidate,
  candidateFoundation,
  candidatePriority,
  remoteTcpTypeForIncoming,
} from "./candidate";
import { MdnsLookup } from "./dns/lookup";
import { TransactionCancelled, type TransactionError } from "./exceptions";
import { type Cancelable, cancelable, PQueue, randomString } from "./helper";
import {
  CandidatePair,
  CandidatePairState,
  CONSENT_INTERVAL,
  CONSENT_TIMEOUT,
  consentResponseTimeoutMs,
  defaultOptions,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  serverReflexiveCandidate,
  sortCandidatePairs,
  validateAddress,
  validateRemoteCandidate,
} from "./iceBase";
import { type Address, debug, Event } from "./imports/common";
import {
  connectionDatagramEvent,
  isAuthenticatedHandshakePair,
} from "./internal/datagram";
import {
  decoratePendingSped,
  getConnectionSpedRuntime,
  setConnectionSpedRuntime,
} from "./internal/sped-bind";
import { SpedBindingResponseCache } from "./internal/sped-binding-cache";
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
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol, TransactionRequestOptions } from "./types/model";
import { getHostAddresses } from "./utils";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

function isTcpActiveCandidate(candidate: {
  transport: string;
  tcptype?: string;
}): boolean {
  return (
    candidate.transport.toLowerCase() === "tcp" &&
    candidate.tcptype === "active"
  );
}

/**
 * One STUN connectivity-check transaction: initial send plus RETRY_MAX
 * retransmissions with doubling RTO. Used as the inbound pair wait so ICE
 * does not hang after known pairs are exhausted (UDP prflx Binding or TCP
 * passive listener).
 */
function stunTransactionLifetimeMs() {
  const tries = 1 + RETRY_MAX;
  return RETRY_RTO * (2 ** tries - 1);
}

/** Fallback STUN server when none is configured (constructor / setIceServers). */
const DEFAULT_STUN_SERVER: Address = ["stun.l.google.com", 19302];

export class Connection implements IceConnection {
  localUsername = randomString(4);
  localPassword = randomString(22);
  remoteIsLite = false;
  remotePassword: string = "";
  remoteUsername: string = "";
  checkList: CandidatePair[] = [];
  localCandidates: Candidate[] = [];
  stunServer?: Address;
  turnServer?: Address;
  options: IceOptions;
  remoteCandidatesEnd = false;
  /**
   * End-of-candidates arrived while earlier candidates were still resolving
   * (mDNS). No candidate is accepted any more; `remoteCandidatesEnd` follows
   * once those resolutions settle.
   */
  private remoteCandidatesEndRequested = false;
  /** mDNS resolutions of remote candidates that arrived before end-of-candidates. */
  private readonly remoteResolutions = new Set<Promise<string>>();
  localCandidatesEnd = false;
  /** connect() began this generation's checks (their outcome sets the state). */
  private checksBegun = false;
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
  lookup?: MdnsLookup;

  private _remoteCandidates: Candidate[] = [];
  // P2P接続完了したソケット
  nominated?: CandidatePair;
  private nominating = false;
  /** Authenticated pair the remote peer last sent application data on. */
  private lastDataPair?: CandidatePair;
  /**
   * Selected pairs of the previous generation (ours and the one the peer was
   * sending on; nomination can be asymmetric). RFC 8445 §9: media continues
   * over the previously selected pair until the restart selects a new one.
   * The peer may keep using it after we nominate, so these are released once
   * the peer sends on an authenticated current-generation pair.
   */
  private previousSelectedPairs: CandidatePair[] = [];
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
   *   check's signal; `isStaleNomination` guards `nominating`, the pair state
   *   and `checkComplete`.
   * - `nominateTcpPair`: this signal; `isStaleNomination`.
   * - `checkProvisional` / `nominateProvisional`: `generation.checks`
   *   (`endProvisional()`, a replacement pranswer, close); `belongs()`.
   * - `queryConsent`: a per-request `AbortController` and
   *   `stopConsentLifecycle()`; `consentSessionId`.
   * - `serverReflexiveCandidate` (gathering): `protocol.close()`; otherwise
   *   it ends by its retransmission timeout, and `stale()` drops the
   *   candidate of an ended gather.
   * - TURN client requests: the `closing` signal and `TurnProtocol.close()`.
   * Regression tests: `tests/ice/check-cancel.test.ts`.
   */
  private remoteChecks = new AbortController();
  private checkListDone = false;
  /** Resolves when the agent closes: work that awaits the network stops waiting. */
  private readonly closedSignal: Promise<void>;
  private signalClosed!: () => void;
  /** Aborted by close(): a TURN allocation still running is released. */
  private readonly closing = new AbortController();
  /**
   * Results for connect(). Known constraint (as in develop): a restart
   * replaces the queue, so a connect() still waiting on the old one never
   * settles (the agent is still collected). It cannot simply return, since
   * the caller (webrtc's `TransactionActivation`) treats a returned start as
   * a connected ICE transport.
   */
  private checkListState = new PQueue<number>();
  private incomingPairWait?: { settle: (learned: boolean) => void };
  private earlyChecks: [Message, Address, Protocol][] = [];
  private earlyChecksDone = false;
  private localCandidatesStart = false;
  private protocols: Protocol[] = [];
  private queryConsentHandle?: Cancelable<void>;
  /** RFC 7675 consent-to-send: application data may use the selected pair. */
  private consentFresh = false;
  /** Invalidates in-flight consent callbacks on restart / close / replace / expire. */
  private consentSessionId = 0;
  private consentExpiryTimer?: ReturnType<typeof setTimeout>;
  private consentRequestAbort?: AbortController;
  /** ICE restart generation checked beside the selected current pair. */
  private provisional?: ProvisionalGeneration;
  /** Last server-reflexive candidate each UDP socket advertised. */
  private readonly reflexiveBySocket = new WeakMap<Protocol, Candidate>();

  readonly onData = new Event<[Buffer]>();
  readonly stateChanged = new Event<[IceState]>();
  readonly onIceCandidate: Event<[Candidate]> = new Event();

  /** @internal SPED controller; unset unless PeerConfig.sped (or tests) attach it. */
  private get spedRuntime(): SpedRuntime | undefined {
    return getConnectionSpedRuntime(this);
  }
  private set spedRuntime(runtime: SpedRuntime | undefined) {
    setConnectionSpedRuntime(this, runtime);
  }
  /**
   * Exact SPED Binding Response bytes keyed by STUN transaction id.
   * Handshake only: TTL = STUN transaction lifetime, LRU-capped.
   */
  private spedBindingCache = new SpedBindingResponseCache();

  constructor(
    private _iceControlling: boolean,
    options?: Partial<IceOptions>,
  ) {
    this.closedSignal = new Promise<void>((resolve) => {
      this.signalClosed = resolve;
    });
    this.options = {
      ...defaultOptions,
      ...options,
    };
    if (this.iceLite) {
      this._iceControlling = false;
    }
    this.applyStunTurnServersFromOptions();
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
    // Explicitly assign server fields even when undefined so a STUN-only
    // update cannot leave a previous TURN host/credential in options.
    this.options = {
      ...this.options,
      stunServer: options.stunServer,
      turnServer: options.turnServer,
      turnUsername: options.turnUsername,
      turnPassword: options.turnPassword,
      turnTransport: options.turnTransport,
    };
    if (options.forceTurn !== undefined) {
      this.options.forceTurn = options.forceTurn;
    }
    if (options.useTcp !== undefined) {
      this.options.useTcp = options.useTcp;
    }
    if (options.turnTlsOptions !== undefined) {
      this.options.turnTlsOptions = options.turnTlsOptions;
    }
    if (options.turnUdpFamily !== undefined) {
      this.options.turnUdpFamily = options.turnUdpFamily;
    }

    this.applyStunTurnServersFromOptions();
    log("Connection ice servers updated", this.options);
  }

  /**
   * Derive Connection.stunServer / turnServer from this.options.
   * Shared by the constructor and setIceServers so both paths validate and
   * default identically.
   */
  private applyStunTurnServersFromOptions() {
    this.stunServer =
      validateAddress(this.options.stunServer) ?? DEFAULT_STUN_SERVER;
    this.turnServer = validateAddress(this.options.turnServer);
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
    const selected = [this.nominated, this.lastDataPair].filter(
      (pair): pair is CandidatePair =>
        pair !== undefined && isAuthenticatedHandshakePair(pair),
    );
    if (selected.length > 0) {
      this.previousSelectedPairs = [...new Set(selected)];
    }
    this.lastDataPair = undefined;
    this.generation++;
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
    this.checksBegun = false;
    this.state = "new";
    this.lookup?.close?.();
    this.lookup = undefined;
    this.nominated = undefined;
    this.nominating = false;
    this.cancelChecks();
    this.checkList = [];
    this.checkListDone = false;
    this.cancelIncomingPairWait();
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
    this.stopConsentLifecycle();
    this.spedBindingCache.clear();
    this.spedRuntime?.reset(this.generation);
    this.endProvisional();
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
    this.nominating = false;
    this.cancelChecks();
    this.checkList = [];
    this.checkListDone = false;
    this.checkListState = new PQueue<number>();
    this.earlyChecks = [];
    this.earlyChecksDone = false;
    this.stopConsentLifecycle();
    this.endProvisional();
  }

  /**
   * Stop the checks and nominations in flight for the checklist a restart
   * replaces (or close ends), and start a signal for the next generation.
   */
  private cancelChecks() {
    this.remoteChecks.abort();
    this.remoteChecks = new AbortController();
    for (const pair of this.checkList) pair.handle?.resolve?.();
  }

  /**
   * Drop the provisional generation and stop the checks still in flight for
   * it (their retransmissions would outlive it).
   */
  private endProvisional() {
    this.provisional?.checks.abort();
    this.provisional = undefined;
  }

  /** Accept provisional checks without changing the selected current pair. */
  stageLocalCredentials(usernameFragment: string, password: string) {
    this.userHistory[usernameFragment] = password;
    this.endProvisional();
    this.provisional = {
      localUsername: usernameFragment,
      localPassword: password,
      remoteCandidates: [],
      remoteCandidatesEnd: false,
      remoteCandidatesEndRequested: false,
      resolutions: new Set(),
      revision: 0,
      pairs: [],
      started: false,
      checks: new AbortController(),
    };
  }

  discardStagedLocalCredentials(usernameFragment: string) {
    if (this.provisional?.localUsername === usernameFragment) {
      this.endProvisional();
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
    const generation = this.provisional;
    if (!generation) return;
    if (
      generation.remoteUsername === usernameFragment &&
      generation.remotePassword === password
    ) {
      return;
    }
    // A replacement pranswer starts a new provisional checklist; candidates
    // still resolving for the replaced one are dropped by `revision`.
    generation.remoteUsername = usernameFragment;
    generation.remotePassword = password;
    generation.remoteCandidates = [];
    generation.remoteCandidatesEnd = false;
    generation.remoteCandidatesEndRequested = false;
    generation.resolutions.clear();
    generation.revision++;
    generation.checks.abort();
    generation.checks = new AbortController();
    generation.pairs = [];
    generation.nominated = undefined;
    generation.nominating = false;
  }

  async addProvisionalRemoteCandidate(remoteCandidate: Candidate | undefined) {
    const generation = this.provisional;
    if (!generation) return;
    const revision = generation.revision;
    const current = () =>
      this.provisional === generation && generation.revision === revision;
    if (!remoteCandidate) {
      if (
        generation.remoteCandidatesEnd ||
        generation.remoteCandidatesEndRequested
      ) {
        return;
      }
      // Candidates that arrived before end-of-candidates finish first.
      generation.remoteCandidatesEndRequested = true;
      if (generation.resolutions.size > 0) {
        await Promise.allSettled([...generation.resolutions]);
        if (!current()) return;
      }
      generation.remoteCandidatesEnd = true;
      return;
    }
    // RFC 8838: a completed generation takes no further candidates.
    if (
      generation.remoteCandidatesEnd ||
      generation.remoteCandidatesEndRequested
    ) {
      return;
    }
    if (remoteCandidate.host.includes(".local")) {
      try {
        if (!this.lookup) {
          this.lookup = new MdnsLookup();
        }
        const resolution = this.lookup.lookup(remoteCandidate.host);
        generation.resolutions.add(resolution);
        try {
          remoteCandidate.host = await resolution;
        } finally {
          generation.resolutions.delete(resolution);
        }
      } catch (error) {
        return;
      }
      // The generation may have been replaced or completed while resolving.
      if (!current() || generation.remoteCandidatesEnd) return;
    }
    try {
      validateRemoteCandidate(remoteCandidate);
    } catch (error) {
      return;
    }
    if (
      !current() ||
      generation.remoteCandidates.some(
        (c) =>
          c.host === remoteCandidate.host &&
          c.port === remoteCandidate.port &&
          c.transport.toLowerCase() === remoteCandidate.transport.toLowerCase(),
      )
    ) {
      return;
    }
    generation.remoteCandidates.push(remoteCandidate);
    for (const protocol of this.protocols) {
      this.tryProvisionalPair(generation, protocol, remoteCandidate);
    }
  }

  /** Start checks for the provisional generation; the selected pair is kept. */
  startProvisionalChecks() {
    const generation = this.provisional;
    if (!generation || generation.started) return;
    generation.started = true;
    for (const remoteCandidate of generation.remoteCandidates) {
      for (const protocol of this.protocols) {
        this.tryProvisionalPair(generation, protocol, remoteCandidate);
      }
    }
    for (const pair of generation.pairs) {
      void this.checkProvisional(generation, pair);
    }
  }

  get provisionalNominated() {
    return this.provisional?.nominated;
  }

  private tryProvisionalPair(
    generation: ProvisionalGeneration,
    protocol: Protocol,
    remoteCandidate: Candidate,
  ) {
    if (
      !protocol.localCandidate?.canPairWith(remoteCandidate) ||
      (protocol.localCandidate.transport.toLowerCase() === "tcp" &&
        protocol.localCandidate.tcptype === "passive" &&
        remoteCandidate.type !== "prflx") ||
      generation.pairs.some(
        (pair) =>
          pair.protocol === protocol &&
          pair.remoteCandidate === remoteCandidate,
      )
    ) {
      return;
    }
    const pair = new CandidatePair(
      protocol,
      remoteCandidate,
      this.iceControlling,
    );
    // The provisional checklist admits the same pairs as the live one.
    if (
      this.options.filterCandidatePair &&
      !this.options.filterCandidatePair(pair)
    ) {
      return;
    }
    pair.updateState(CandidatePairState.WAITING);
    generation.pairs.push(pair);
    if (generation.started) void this.checkProvisional(generation, pair);
  }

  private async checkProvisional(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
    retry = true,
  ): Promise<void> {
    const revision = generation.revision;
    // A check belongs to one checklist: a replacement pranswer (new revision)
    // or a replaced generation makes its outcome meaningless.
    const belongs = () =>
      this.provisional === generation &&
      generation.revision === revision &&
      generation.pairs.includes(pair);
    if (
      // An ICE-lite agent only answers checks (RFC 8445 §2.5), in the
      // provisional generation as in the live one.
      this.iceLite ||
      !belongs() ||
      !generation.started ||
      !generation.remoteUsername ||
      !generation.remotePassword ||
      [CandidatePairState.IN_PROGRESS, CandidatePairState.SUCCEEDED].includes(
        pair.state,
      )
    ) {
      return;
    }
    pair.updateState(CandidatePairState.IN_PROGRESS);
    const nominate = this.iceControlling && !this.remoteIsLite;
    const request = this.buildRequest({
      nominate,
      localUsername: generation.localUsername,
      remoteUsername: generation.remoteUsername,
      iceControlling: this.iceControlling,
      localCandidate: pair.localCandidate,
    });
    try {
      pair.requestsSent++;
      const [, addr] = await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(generation.remotePassword, "utf8"),
        {
          retransmissions:
            pair.localCandidate.transport.toLowerCase() === "tcp" ? 0 : 4,
          signal: generation.checks.signal,
        },
      );
      pair.responsesReceived++;
      if (!belongs()) return;
      if (addr[0] !== pair.remoteAddr[0] || addr[1] !== pair.remoteAddr[1]) {
        pair.updateState(CandidatePairState.FAILED);
        return;
      }
    } catch (error) {
      if (!belongs()) return;
      const code = (error as TransactionError).response?.getAttributeValue(
        "ERROR-CODE",
      )?.[0];
      pair.updateState(CandidatePairState.FAILED);
      if (code === 487 && retry) {
        this.switchRole(request.attributesKeys.includes("ICE-CONTROLLED"));
        pair.updateState(CandidatePairState.WAITING);
        return this.checkProvisional(generation, pair, false);
      }
      return;
    }
    if (nominate || pair.remoteNominated) pair.nominated = true;
    pair.updateState(CandidatePairState.SUCCEEDED);
    if (
      !pair.nominated &&
      this.iceControlling &&
      !generation.nominated &&
      !generation.nominating
    ) {
      // Regular nomination (the peer is ICE-lite, so the checks carried no
      // USE-CANDIDATE), as the live checklist does: nominate the first pair
      // that succeeded with a check that carries it.
      await this.nominateProvisional(generation, pair, belongs);
    }
    if (pair.nominated && !generation.nominated) {
      log("provisional nominated", pair.toJSON());
      generation.nominated = pair;
    }
  }

  private async nominateProvisional(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
    belongs: () => boolean,
  ) {
    generation.nominating = true;
    const request = this.buildRequest({
      nominate: true,
      localUsername: generation.localUsername,
      remoteUsername: generation.remoteUsername!,
      iceControlling: this.iceControlling,
      localCandidate: pair.localCandidate,
    });
    try {
      pair.requestsSent++;
      await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(generation.remotePassword!, "utf8"),
        {
          retransmissions:
            pair.localCandidate.transport.toLowerCase() === "tcp" ? 0 : 4,
          // endProvisional / a replacement pranswer stops it with the checks.
          signal: generation.checks.signal,
        },
      );
      pair.responsesReceived++;
      if (belongs()) pair.nominated = true;
    } catch (error) {
      log("provisional regular nomination failed", error);
    } finally {
      if (belongs()) generation.nominating = false;
    }
  }

  /** Incoming check for the provisional ufrag; never touches the current checklist. */
  private checkIncomingProvisional(
    generation: ProvisionalGeneration,
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) {
    // Only checks from the remote credentials of the current checklist count
    // (a replacement pranswer replaced any earlier ones).
    const txUsername = message.getAttributeValue("USERNAME");
    const sender =
      typeof txUsername === "string"
        ? decodeTxUsername(txUsername).localUsername
        : undefined;
    if (generation.remoteUsername && sender !== generation.remoteUsername) {
      return;
    }
    const [host, port] = addr;
    let remoteCandidate = generation.remoteCandidates.find(
      (c) => c.host === host && c.port === port,
    );
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
      generation.remoteCandidates.push(remoteCandidate);
    }
    let pair = generation.pairs.find(
      (p) => p.protocol === protocol && p.remoteCandidate === remoteCandidate,
    );
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate, this.iceControlling);
      pair.updateState(CandidatePairState.WAITING);
      generation.pairs.push(pair);
    }
    pair.noteIncomingRequest(message.transactionIdHex);
    pair.requestsReceived++;
    pair.responsesSent++;

    if (
      message.attributesKeys.includes("USE-CANDIDATE") &&
      !this.iceControlling
    ) {
      pair.remoteNominated = true;
      if (this.iceLite || pair.state === CandidatePairState.SUCCEEDED) {
        pair.nominated = true;
        pair.updateState(CandidatePairState.SUCCEEDED);
        generation.nominated ??= pair;
      }
    }
    if (
      !this.iceLite &&
      [CandidatePairState.WAITING, CandidatePairState.FAILED].includes(
        pair.state,
      )
    ) {
      void this.checkProvisional(generation, pair);
    }
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
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.nominating = false;
    // Drop old pair's consent timers/transactions; restarted when a new pair is nominated.
    this.stopConsentLifecycle();
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
      this.protocols = this.protocols.filter(
        (protocol) => !previousTurn.includes(protocol),
      );
      void Promise.allSettled(previousTurn.map((protocol) => protocol.close()));

      // ICE restart keeps transport protocols; re-advertise their host candidates
      // with the new generation / ufrag before gathering additional addresses.
      for (const protocol of this.protocols) {
        if (protocol.localCandidate) {
          protocol.localCandidate.generation = this.generation;
          protocol.localCandidate.ufrag = this.localUsername;
          this.appendLocalCandidate(protocol.localCandidate);
          const reflexive = this.reflexiveBySocket.get(protocol);
          if (reflexive) {
            this.appendLocalCandidate(this.withGeneration(reflexive));
          }
        }
      }

      let address = getHostAddresses(
        this.options.useIpv4,
        this.options.useIpv6,
        {
          useLinkLocalAddress: this.options.useLinkLocalAddress,
        },
      );
      const { interfaceAddresses } = this.options;
      if (interfaceAddresses) {
        const filteredAddresses = address.filter((check) =>
          Object.values(interfaceAddresses).includes(check),
        );
        if (filteredAddresses.length) {
          address = filteredAddresses;
        }
      }
      if (this.options.additionalHostAddresses) {
        address = Array.from(
          new Set([...this.options.additionalHostAddresses, ...address]),
        );
      }

      const candidatePromises = this.getCandidatePromises(
        address,
        this.options.stunGatherTimeout,
        generation,
      );
      // close() ends the gathering at once: the continuations above close
      // whatever a server query still opens for a closed agent.
      await Promise.race([
        Promise.allSettled(candidatePromises),
        this.closedSignal,
      ]);

      // A later ICE restart (or close) owns the agent now: this gathering
      // neither completes that generation nor touches its state.
      if (!this.isGathering(generation)) return;
      this.localCandidatesEnd = true;
    }
    // Gathering that finishes after connectivity checks began (an ICE restart
    // keeps gathering from its servers) must not overwrite their state: the
    // agent stays "new" while checking, and only the checks' outcome moves it.
    if (this.state === "new" && !this.checksBegun) this.setState("completed");
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
    return !!this.stunServer || !!this.turnServer;
  }

  private appendLocalCandidate(candidate: Candidate) {
    this.localCandidates.push(candidate);
    this.onIceCandidate.execute(candidate);
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
        if (authenticated) {
          this.lastDataPair = pair;
          this.previousSelectedPairs = [];
        }
        connectionDatagramEvent(this).execute({
          bytes: data,
          // Never copy pair.remoteAddr into source: a missing addr must not
          // look like an authenticated 5-tuple match.
          source: addr ?? ["0.0.0.0", 0],
          protocol,
          pair,
          generation: this.generation,
          authenticated,
          // A new-generation pair for the same 5-tuple may already exist
          // (WAITING/IN_PROGRESS) before it is authenticated; that must not
          // hide the retained previous selected path.
          fromPreviousSelectedPair:
            !authenticated && this.isPreviousSelectedPair(protocol, addr),
        });

        const activePair = this.nominated;
        if (activePair && activePair.protocol === protocol) {
          activePair.packetsReceived++;
          activePair.bytesReceived += data.length;
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
    this.stopConsentLifecycle();
    this.setState("failed");
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

    const verified = parseMessage(data, Buffer.from(localPassword, "utf8"));
    if (!verified) {
      log("drop unauthenticated Binding Request");
      return;
    }

    const isCurrentGeneration = localUsername === this.localUsername;

    if (!isCurrentGeneration) {
      const provisional = this.provisional;
      const isProvisional =
        !!provisional && localUsername === provisional.localUsername;
      if (
        isProvisional &&
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
      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        verified.transactionId,
      );
      response
        .setAttribute("XOR-MAPPED-ADDRESS", addr)
        .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
        .addFingerprint();
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });
      if (provisional && isProvisional) {
        this.checkIncomingProvisional(provisional, verified, addr, protocol);
      }
      return;
    }

    const { iceControlling } = this;
    await this.handleCurrentGenerationBinding(
      protocol,
      verified,
      addr,
      localPassword,
      iceControlling,
    );
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
    const deferIncoming = !this.earlyChecksDone;
    let pair = this.findPairByAddr(protocol, addr);
    if (!pair) {
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

    const { finish } = this.spedBindingCache.begin(txHex);
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
      if (pair) {
        const decorated = this.spedRuntime
          ? this.spedRuntime.decorateOutgoing(response, pair)
          : decoratePendingSped(this, response, pair);
        if (!decorated) {
          return;
        }
      }
      response
        .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
        .addFingerprint();
      const wire = Buffer.from(response.bytes);
      this.storeSpedBindingResponse(txHex, wire);
      result = wire;
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

  private getCandidatePromises(
    addresses: string[],
    timeout = 5,
    generation = this.generation,
  ) {
    const candidatePromises: Promise<unknown>[] = [];
    // Each continuation below runs after an await: a socket or allocation it
    // opened for a replaced generation (or a closed agent) is closed, and
    // nothing is added to the current one.
    const stale = () => !this.isGathering(generation);
    const { stunServer, turnServer } = this;
    const { turnUsername, turnPassword } = this.options;
    const gatherIceLite = this.iceLite;
    const gatherRelayOnly =
      !gatherIceLite &&
      this.options.forceTurn &&
      turnServer &&
      turnUsername &&
      turnPassword;

    addresses = addresses.filter((address) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      if (this.protocols.find((protocol) => protocol.localIp === address)) {
        return false;
      }
      return true;
    });
    // An ICE restart keeps its UDP sockets. They are not re-created above, but
    // their server-reflexive address is part of the new generation too, so
    // the STUN query below runs for them as well.
    const reusedStunProtocols = this.protocols.filter(
      (protocol): protocol is StunProtocol =>
        protocol instanceof StunProtocol &&
        protocol.localCandidate?.type === "host" &&
        protocol.localCandidate.transport === "udp",
    );

    const localStunPromises = gatherRelayOnly
      ? []
      : addresses.map(async (address) => {
          // # create transport
          const protocol = new StunProtocol();
          this.ensureProtocol(protocol);
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.options.portRange,
              this.options.interfaceAddresses,
            );
            if (stale()) {
              await protocol.close();
              return;
            }

            protocol.localIp = address;
            this.protocols.push(protocol);

            log("protocol", protocol.localIp);

            // # add host candidate
            const candidateAddress: Address = [
              address,
              protocol.getExtraInfo()[1],
            ];

            protocol.localCandidate = new Candidate(
              candidateFoundation("host", "udp", candidateAddress[0]),
              1,
              "udp",
              candidatePriority("host", { transport: "udp" }),
              candidateAddress[0],
              candidateAddress[1],
              "host",
              undefined,
              undefined,
              undefined,
              this.generation,
              this.localUsername,
            );

            this.pairLocalProtocol(protocol);
            this.appendLocalCandidate(protocol.localCandidate);

            return protocol;
          } catch (error) {
            log("error protocol STUN", error);
          }
        });

    if (!gatherRelayOnly) {
      candidatePromises.push(
        ...localStunPromises.map((localPromise) =>
          localPromise.then((protocol) => protocol?.localCandidate),
        ),
      );
    }

    if (!gatherRelayOnly && this.options.useTcp) {
      const tcpCandidatePromises = addresses.map(async (address) => {
        // Passive candidates open a listening TCP server; skip them when the
        // agent only makes outbound connections (tcpPassive === false). Active
        // candidates below still dial out, so direct TCP egress is unaffected.
        if (this.options.tcpPassive !== false) {
          const passiveProtocol = new TcpPassiveProtocol();
          this.ensureProtocol(passiveProtocol);
          await passiveProtocol.connectionMade(address, this.options.portRange);
          if (stale()) {
            await passiveProtocol.close();
            return;
          }
          passiveProtocol.localIp = address;
          passiveProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "passive",
            }),
            address,
            passiveProtocol.listeningPort,
            "host",
            undefined,
            undefined,
            "passive",
            this.generation,
            this.localUsername,
          );
          this.protocols.push(passiveProtocol);
          this.appendLocalCandidate(passiveProtocol.localCandidate);
        }

        if (!gatherIceLite) {
          const activeProtocol = new TcpActiveProtocol();
          this.ensureProtocol(activeProtocol);
          await activeProtocol.connectionMade(address);
          if (stale()) {
            await activeProtocol.close();
            return;
          }
          activeProtocol.localIp = address;
          activeProtocol.localCandidate = new Candidate(
            candidateFoundation("host", "tcp", address),
            1,
            "tcp",
            candidatePriority("host", {
              transport: "tcp",
              tcptype: "active",
            }),
            address,
            9,
            "host",
            undefined,
            undefined,
            "active",
            this.generation,
            this.localUsername,
          );
          this.protocols.push(activeProtocol);
          this.pairLocalProtocol(activeProtocol);
          this.appendLocalCandidate(activeProtocol.localCandidate);
        }
      });

      candidatePromises.push(...tcpCandidatePromises);
    }

    if (!gatherIceLite && !gatherRelayOnly && stunServer) {
      // Sockets kept across an ICE restart query STUN again. The mapping they
      // already advertised is in the new generation from the start; a
      // different fresh mapping (the NAT rebound) is added to it.
      const reusedReflexivePromises = reusedStunProtocols
        .filter((protocol) => isIPv4(protocol.localCandidate!.host))
        .map(async (protocol) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const fresh = await Promise.race([
            serverReflexiveCandidate(protocol, stunServer).catch(
              () => undefined,
            ),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), timeout * 1000);
            }),
          ]);
          clearTimeout(timer);
          if (stale()) return;
          const previous = this.reflexiveBySocket.get(protocol);
          if (
            fresh &&
            (fresh.host !== previous?.host || fresh.port !== previous?.port)
          ) {
            this.reflexiveBySocket.set(protocol, fresh);
            this.appendLocalCandidate(fresh);
          }
          return fresh ?? previous;
        });
      candidatePromises.push(...reusedReflexivePromises);

      const stunCandidatePromises = localStunPromises.map(
        async (protocolPromise) => {
          const protocol = await protocolPromise;
          if (!protocol) return;

          const stunCandidatePromise = new Promise<Candidate | void>(
            async (r, f) => {
              const timer = setTimeout(f, timeout * 1000);
              if (
                protocol.localCandidate?.host &&
                isIPv4(protocol.localCandidate?.host)
              ) {
                const candidate = await serverReflexiveCandidate(
                  protocol,
                  stunServer,
                ).catch((error) => {
                  log("error", error);
                });
                if (candidate && !stale()) {
                  this.reflexiveBySocket.set(protocol, candidate);
                  this.appendLocalCandidate(candidate);
                }

                clearTimeout(timer);
                r(candidate);
              } else {
                clearTimeout(timer);
                r();
              }
            },
          ).catch((error) => {
            log("query STUN server", error);
          });

          return stunCandidatePromise;
        },
      );

      candidatePromises.push(...stunCandidatePromises);
    }

    if (!gatherIceLite && turnServer && turnUsername && turnPassword) {
      const turnCandidatePromise = (async () => {
        const turnTransport = this.options.turnTransport ?? "udp";
        const protocol = await createStunOverTurnClient(
          {
            address: turnServer,
            username: turnUsername,
            password: turnPassword,
          },
          {
            portRange: this.options.portRange,
            interfaceAddresses: this.options.interfaceAddresses,
            transport: turnTransport,
            tlsOptions: this.options.turnTlsOptions,
            connectTimeoutMs: (this.options.turnConnectTimeout ?? 8) * 1000,
            udpFamily: this.options.turnUdpFamily,
            signal: this.closing.signal,
          },
        ).catch(async (e) => {
          // close() cancelled the allocation: no TCP fallback.
          if (turnTransport === "udp" && !this.closing.signal.aborted) {
            return await createStunOverTurnClient(
              {
                address: turnServer,
                username: turnUsername,
                password: turnPassword,
              },
              {
                portRange: this.options.portRange,
                interfaceAddresses: this.options.interfaceAddresses,
                transport: "tcp",
                connectTimeoutMs: (this.options.turnConnectTimeout ?? 8) * 1000,
                signal: this.closing.signal,
              },
            );
          } else {
            throw e;
          }
        });
        if (stale()) {
          // The allocation never joins a generation: release it (and its
          // refresh timer) instead of keeping a second one alive.
          await protocol.close();
          return;
        }
        this.ensureProtocol(protocol);
        this.protocols.push(protocol);

        const candidateAddress = protocol.turn.relayedAddress;
        const relatedAddress = protocol.turn.mappedAddress;

        log("turn candidateAddress", candidateAddress);

        protocol.localCandidate = new Candidate(
          candidateFoundation("relay", "udp", candidateAddress[0]),
          1,
          "udp",
          candidatePriority("relay"),
          candidateAddress[0],
          candidateAddress[1],
          "relay",
          relatedAddress[0],
          relatedAddress[1],
          undefined,
          this.generation,
          this.localUsername,
        );
        // An allocation that completes after the remote candidates arrived
        // (early signaling, or an ICE restart that allocates afresh) pairs
        // with them; a connect() already running schedules the new pairs.
        this.pairLocalProtocol(protocol);
        this.appendLocalCandidate(protocol.localCandidate);

        return protocol.localCandidate;
      })().catch((error) => {
        log("query TURN server", error);
      });

      candidatePromises.push(turnCandidatePromise);
    }

    return candidatePromises;
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

    if (this.iceLite) {
      if (!this.nominated) {
        let res: number = ICE_FAILED;
        while (!this.checkListDone && this.state !== "closed") {
          res = await this.checkListState.get();
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
    for (;;) {
      if (this.state === "closed") break;
      if (!this.schedulingChecks()) break;
      await timers.setTimeout(20);
    }

    // # wait for completion
    let res: number = ICE_FAILED;
    while (res === ICE_FAILED && this.state !== "closed") {
      if (this.nominated || this.checkListDone) {
        res = ICE_COMPLETED;
        break;
      }
      // A regular nomination in flight (TCP) settles through checkComplete,
      // not through a newly learned incoming pair.
      if (
        this.hasOutstandingChecks() ||
        this.nominating ||
        this.isWaitingForRemoteNomination()
      ) {
        res = await this.checkListState.get();
        log("checkListState", res);
        continue;
      }
      if (!this.canLearnIncomingPair()) {
        break;
      }
      const learned = await this.waitForIncomingPair();
      if (!learned) {
        break;
      }
    }

    // # cancel remaining checks
    for (const check of this.checkList) {
      check.handle?.resolve?.();
    }

    if (res !== ICE_COMPLETED && !this.nominated) {
      if (this.state !== "closed") {
        this.setState("failed");
      }
      throw new Error("ICE negotiation failed");
    }

    // # start consent freshness tests
    this.queryConsent();

    this.setState("connected");
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
            this.options.forceTurn &&
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
   * Stop consent request cadence, expiry timer, and outstanding transactions.
   * Does not change ICE state by itself.
   */
  private stopConsentLifecycle() {
    this.consentSessionId++;
    this.consentFresh = false;
    if (this.consentExpiryTimer !== undefined) {
      clearTimeout(this.consentExpiryTimer);
      this.consentExpiryTimer = undefined;
    }
    this.consentRequestAbort?.abort();
    this.consentRequestAbort = undefined;
    const handle = this.queryConsentHandle;
    this.queryConsentHandle = undefined;
    // Resolve after clearing the field so a stale onCancel cannot wipe a replacement.
    handle?.resolve?.();
  }

  /**
   * ICE-lite interop only (not required by RFC 7675): mirror libwebrtc
   * semi-aggressive nomination — attach USE-CANDIDATE when we are controlling,
   * the remote is ICE-lite, and the target is the current selected pair.
   */
  private shouldNominateConsentRequest(pair: CandidatePair): boolean {
    return (
      this.iceControlling && this.remoteIsLite && this.nominated?.id === pair.id
    );
  }

  /**
   * @internal
   * Return whether application data can be delivered on the selected pair.
   * This is kept separate from {@link send} so transports that buffer data
   * can distinguish an unavailable path from a successful no-op.
   */
  canSendApplicationData(): boolean {
    const activePair = this.applicationDataPair();
    if (!activePair) {
      return false;
    }
    if (this.state === "closed" || this.state === "failed") {
      return false;
    }
    // Local ICE-lite does not run consent checks; full agents need fresh consent.
    if (this.iceLite) {
      return true;
    }
    // Full ICE requires consent from a successful Binding response. A remote
    // USE-CANDIDATE only records nomination; it does not prove that this peer
    // can receive application data on the pair.
    return this.consentFresh;
  }

  private applicationDataPair(): CandidatePair | undefined {
    if (
      this.nominated &&
      this.nominated.state === CandidatePairState.SUCCEEDED
    ) {
      return this.nominated;
    }
    return this.checkList.find(
      (pair) =>
        pair.state === CandidatePairState.SUCCEEDED &&
        isAuthenticatedHandshakePair(pair) &&
        (pair.nominated || (this.iceLite && pair.remoteNominated)),
    );
  }

  private abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  // RFC 7675 consent freshness
  private queryConsent = () => {
    if (this.iceLite) {
      return;
    }

    // Invalidate any previous consent session before starting a new one.
    this.stopConsentLifecycle();
    const sessionId = this.consentSessionId;
    this.consentFresh = true;

    const handle = cancelable<void>(async (_, __, onCancel) => {
      let canceled = false;
      const cancelEvent = new AbortController();

      const clearConsentExpiry = () => {
        if (this.consentExpiryTimer === undefined) {
          return;
        }
        clearTimeout(this.consentExpiryTimer);
        this.consentExpiryTimer = undefined;
      };

      const refreshConsentExpiry = () => {
        // Only the active session may refresh the shared expiry timer.
        if (canceled || sessionId !== this.consentSessionId) {
          return;
        }
        clearConsentExpiry();
        this.consentExpiryTimer = setTimeout(() => {
          this.consentExpiryTimer = undefined;
          if (canceled || sessionId !== this.consentSessionId) {
            return;
          }
          if (this.state === "closed" || this.state === "failed") {
            return;
          }
          log("Consent to send expired");
          // Expire independently of request cadence / failure count (RFC 7675).
          this.consentFresh = false;
          this.consentSessionId++;
          this.consentRequestAbort?.abort();
          this.consentRequestAbort = undefined;
          if (this.queryConsentHandle === handle) {
            this.queryConsentHandle = undefined;
          }
          canceled = true;
          cancelEvent.abort();
          // Transport stays available for ICE restart; explicit close() uses "closed".
          this.setState("failed");
        }, CONSENT_TIMEOUT * 1000);
      };

      onCancel.once(() => {
        canceled = true;
        // Avoid clearing a replacement session's timer/handle.
        if (sessionId === this.consentSessionId) {
          clearConsentExpiry();
          this.consentRequestAbort?.abort();
          this.consentRequestAbort = undefined;
        }
        cancelEvent.abort();
        if (this.queryConsentHandle === handle) {
          this.queryConsentHandle = undefined;
        }
      });

      // Initial ICE check success is the first valid consent response.
      refreshConsentExpiry();

      const randomizedConsentInterval = () =>
        CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000;

      // Cadence is measured between request *starts*, not response completions.
      let nextConsentAt = Date.now() + randomizedConsentInterval();
      const isTerminalState = () =>
        this.state === "closed" || this.state === "failed";

      try {
        while (
          !isTerminalState() &&
          !canceled &&
          sessionId === this.consentSessionId
        ) {
          await this.abortableDelay(
            Math.max(0, nextConsentAt - Date.now()),
            cancelEvent.signal,
          );

          if (
            canceled ||
            isTerminalState() ||
            sessionId !== this.consentSessionId
          ) {
            break;
          }

          // Fix next start time before awaiting any response (independent timers).
          nextConsentAt = Date.now() + randomizedConsentInterval();

          const nominated = this.nominated;
          if (!nominated) {
            break;
          }

          const pairId = nominated.id;
          const localGeneration = this.generation;
          const remoteGeneration = this.remoteGeneration;
          const remotePassword = this.remotePassword;
          const { localUsername, remoteUsername, iceControlling } = this;

          const request = this.buildRequest({
            nominate: this.shouldNominateConsentRequest(nominated),
            localUsername,
            remoteUsername,
            iceControlling,
            localCandidate: nominated.localCandidate,
          });
          if (!this.decorateSpedRequest(request, nominated)) {
            continue;
          }

          this.consentRequestAbort?.abort();
          const requestAbort = new AbortController();
          this.consentRequestAbort = requestAbort;

          nominated.consentRequestsSent++;
          nominated.requestsSent++;

          // RTT-aware wait (floor 500ms); independent of retransmissions: 0.
          const responseTimeout = consentResponseTimeoutMs(nominated.rtt);
          const requestStartedAt = performance.now();

          // Do not await here: response wait must not stretch the 4–6s cadence.
          nominated.protocol
            .request(
              request,
              nominated.remoteAddr,
              Buffer.from(remotePassword, "utf8"),
              {
                retransmissions: 0,
                responseTimeout,
                signal: requestAbort.signal,
                onRequestSent: (attempt) => {
                  if (attempt > 0) {
                    nominated.retransmissionsSent++;
                  }
                },
              },
            )
            .then(async ([response, addr]) => {
              // Accept only responses for the current pair / generation / session.
              // Address / MESSAGE-INTEGRITY / response class are enforced in Transaction + protocol.
              if (sessionId !== this.consentSessionId || canceled) {
                return;
              }
              const state = this.state;
              if (state === "closed" || state === "failed") {
                return;
              }
              if (this.nominated?.id !== pairId) {
                return;
              }
              if (
                this.generation !== localGeneration ||
                this.remoteGeneration !== remoteGeneration
              ) {
                return;
              }
              if (this.remotePassword !== remotePassword) {
                return;
              }

              const rtt = (performance.now() - requestStartedAt) / 1000; // seconds
              nominated.rtt = rtt;
              nominated.totalRoundTripTime += rtt;
              nominated.roundTripTimeMeasurements++;

              nominated.responsesReceived++;
              this.consentFresh = true;
              refreshConsentExpiry();
              if (state === "disconnected") {
                this.setState("connected");
              }
              await this.consumeSpedStun(
                response,
                addr,
                nominated.protocol,
                nominated,
                localGeneration,
              );
            })
            .catch((error) => {
              // Individual request loss is expected; keep monitoring (RFC 7675).
              if (
                sessionId === this.consentSessionId &&
                this.nominated?.id === pairId
              ) {
                log("no stun response", error);
              }
            });
        }
      } catch (error) {
        // Abort during delay is normal on cancel / expire.
      } finally {
        if (sessionId === this.consentSessionId) {
          clearConsentExpiry();
        }
      }
    });
    this.queryConsentHandle = handle;
  };

  async close() {
    // """
    // Close the connection.
    // """

    this.setState("closed");
    this.cancelIncomingPairWait();
    this.signalClosed();
    this.closing.abort();
    this.cancelChecks();
    this.endProvisional();

    // # stop consent freshness tests
    this.stopConsentLifecycle();

    // # stop check list
    if (this.checkList && !this.checkListDone) {
      this.checkListState.put(
        new Promise((r) => {
          r(ICE_FAILED);
        }),
      );
    }

    this.nominated = undefined;
    this.lastDataPair = undefined;
    this.previousSelectedPairs = [];
    for (const protocol of this.protocols) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];

    this.lookup?.close?.();
    this.lookup = undefined;
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

    if (!remoteCandidate) {
      if (this.remoteCandidatesEnd || this.remoteCandidatesEndRequested) {
        return;
      }
      // Candidates that arrived before end-of-candidates finish first.
      this.remoteCandidatesEndRequested = true;
      if (this.remoteResolutions.size > 0) {
        const generation = this.remoteGeneration;
        await Promise.allSettled([...this.remoteResolutions]);
        if (this.remoteGeneration !== generation) return;
      }
      this.remoteCandidatesEnd = true;
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
      // An ICE restart or completion while resolving ends this candidate's generation.
      if (this.remoteGeneration !== generation || this.remoteCandidatesEnd)
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
    const activePair = this.applicationDataPair();
    if (!activePair) {
      return;
    }
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

  private isPreviousSelectedPair(protocol: Protocol, addr?: Address) {
    if (addr === undefined) {
      return false;
    }
    return this.previousSelectedPairs.some(
      (previous) =>
        previous.protocol === protocol &&
        previous.remoteAddr[0] === addr[0] &&
        previous.remoteAddr[1] === addr[1],
    );
  }

  private hasOutstandingChecks(): boolean {
    return this.checkList.some(
      (pair) =>
        pair.state === CandidatePairState.WAITING ||
        pair.state === CandidatePairState.FROZEN ||
        pair.state === CandidatePairState.IN_PROGRESS,
    );
  }

  private isWaitingForRemoteNomination(): boolean {
    return (
      !this.iceControlling &&
      this.checkList.some((pair) => pair.state === CandidatePairState.SUCCEEDED)
    );
  }

  private canLearnIncomingPair(): boolean {
    if (this.checkListDone || this.nominated || this.state === "closed") {
      return false;
    }
    if (this.hasOutstandingChecks()) {
      return false;
    }
    const hasLocalUdpReceiver = this.protocols.some((protocol) => {
      const local = protocol.localCandidate;
      if (!local || local.transport.toLowerCase() !== "udp") {
        return false;
      }
      return local.type === "host" || local.type === "srflx";
    });
    if (hasLocalUdpReceiver) {
      return true;
    }
    const hasLocalPassive = this.protocols.some(
      (protocol) =>
        protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
        protocol.localCandidate.tcptype === "passive",
    );
    if (!hasLocalPassive) {
      return false;
    }
    return this.remoteCandidates.some((candidate) =>
      isTcpActiveCandidate(candidate),
    );
  }

  private waitForIncomingPair(): Promise<boolean> {
    if (this.state === "closed") {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const settle = (learned: boolean) => {
        if (this.incomingPairWait?.settle !== settle) {
          return;
        }
        this.incomingPairWait = undefined;
        clearTimeout(timer);
        resolve(learned);
      };
      const timer = setTimeout(
        () => settle(false),
        stunTransactionLifetimeMs(),
      );
      this.incomingPairWait = { settle };
    });
  }

  private cancelIncomingPairWait() {
    this.incomingPairWait?.settle(false);
  }

  private decorateSpedRequest(request: Message, pair: CandidatePair): boolean {
    const runtime = this.spedRuntime;
    return runtime
      ? runtime.decorateOutgoing(request, pair)
      : decoratePendingSped(this, request, pair);
  }

  private bindingResponseSourceMatches(
    addr: Address | undefined,
    pair: CandidatePair,
  ): boolean {
    return (
      addr != null &&
      addr[0] === pair.remoteAddr[0] &&
      addr[1] === pair.remoteAddr[1]
    );
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
    await runtime.handleAuthenticatedStun(
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
    this.settleSpedUnconfirmed(pair);
    await this.maybeSendSpedFallback(protocol, addr, generation);
  }

  private applyIceControlling(iceControlling: boolean) {
    this._iceControlling = iceControlling;
    for (const pair of this.checkList) {
      pair.iceControlling = iceControlling;
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
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
      const settled = this.settleSpedUnconfirmed(pair);
      void this.flushSpedUnconfirmedFallback(settled ?? pair);
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
        this.nominated == undefined
      ) {
        log("nominated", pair.toJSON());
        this.nominated = pair;
        this.nominating = false;
        // RFC 7675 section 5.1: the successful connectivity check that
        // selected the pair is its initial consent, so data may flow at once
        // instead of waiting for the consent lifecycle to start.
        this.consentFresh = true;
        this.pruneTcpConnections(pair);

        // After resetNominatedPair / renomination while already connected,
        // restart consent freshness on the new selected pair.
        if (
          !this.iceLite &&
          (this.state === "connected" || this.state === "completed")
        ) {
          this.queryConsent();
        }

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream.
        for (const p of this.checkList) {
          if (
            p.component === pair.component &&
            [CandidatePairState.WAITING, CandidatePairState.FROZEN].includes(
              p.state,
            )
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

    this.nominateTcpPairIfReady();

    // A nomination request is still in flight; its result decides the outcome.
    if (this.nominating) {
      return;
    }

    {
      const list = [CandidatePairState.SUCCEEDED, CandidatePairState.FAILED];
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
      const { remotePassword, remoteUsername, generation } = this;
      const localUsername = pair.localCandidate.ufrag ?? this.localUsername;
      const stopIfStale = () => {
        if (!this.isStaleConnectivityCheck(pair, generation)) {
          return false;
        }
        r();
        return true;
      };

      // TCP pairs use regular nomination (see nominateTcpPairIfReady).
      const nominate =
        this.iceControlling && !this.remoteIsLite && !this.isTcpPair(pair);
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
        if (!this.bindingResponseSourceMatches(addr, pair)) {
          pair.updateState(CandidatePairState.FAILED);
          this.checkComplete(pair);
          r();
          return;
        }

        pair.responsesReceived++;
        const endTime = performance.now();
        const rtt = (endTime - startTime) / 1000;
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
        this.spedRuntime?.tryMarkDirectHandshakeReady(pair, generation);
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

      // # success
      if (nominate || pair.remoteNominated) {
        // # nominated by agressive nomination or the remote party
        pair.nominated = true;
      } else if (this.usesTcpRegularNomination(pair)) {
        // # nominated later by nominateTcpPairIfReady (from checkComplete)
      } else if (this.iceControlling && !this.nominating) {
        // # perform regular nomination
        this.nominating = true;
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
          if (!this.bindingResponseSourceMatches(nomAddr, pair)) {
            pair.updateState(CandidatePairState.FAILED);
            this.checkComplete(pair);
            r();
            return;
          }
          pair.responsesReceived++;
          this.spedRuntime?.tryMarkDirectHandshakeReady(pair, generation);
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
          this.nominating = false;
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
        pair.nominated = true;
      }

      if (stopIfStale()) {
        return;
      }
      pair.updateState(CandidatePairState.SUCCEEDED);
      this.checkComplete(pair);
      r();
    });

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

  /**
   * Aggressive nomination lets each side settle on whichever TCP connection
   * finished first; the two sides can then pick different connections and
   * pruning destroys the peer's choice. For TCP the controlling agent instead
   * nominates exactly one valid pair (RFC 8445 §8.1.1 regular nomination).
   */
  private usesTcpRegularNomination(pair: CandidatePair) {
    return this.iceControlling && !this.remoteIsLite && this.isTcpPair(pair);
  }

  private checkRequestOptions(pair: CandidatePair): TransactionRequestOptions {
    const onRequestSent = (attempt: number) => {
      if (attempt > 0) {
        pair.retransmissionsSent++;
      }
    };
    if (this.isTcpPair(pair)) {
      // RFC 5389 §7.2.2: no retransmissions over a reliable transport.
      return {
        retransmissions: 0,
        responseTimeout: TCP_CHECK_RESPONSE_TIMEOUT_MS,
        onRequestSent,
      };
    }
    return { retransmissions: 4, onRequestSent };
  }

  /**
   * Controlling side: nominate the highest-priority TCP pair once every
   * higher-priority TCP pair has finished its check, so the choice does not
   * depend on which connection happened to complete first.
   */
  private nominateTcpPairIfReady() {
    if (
      !this.iceControlling ||
      this.remoteIsLite ||
      this.nominated ||
      this.nominating
    ) {
      return;
    }

    for (const pair of this.checkList) {
      if (!this.isTcpPair(pair)) {
        continue;
      }
      if (pair.state === CandidatePairState.SUCCEEDED) {
        this.nominateTcpPair(pair);
        return;
      }
      if (pair.state !== CandidatePairState.FAILED) {
        // A higher-priority pair may still succeed.
        return;
      }
    }
  }

  private nominateTcpPair(pair: CandidatePair) {
    this.nominating = true;
    void this.sendTcpNomination(pair, this.remoteGeneration);
  }

  private async sendTcpNomination(pair: CandidatePair, generation: number) {
    const fail = () => {
      this.nominating = false;
      pair.updateState(CandidatePairState.FAILED);
      this.checkComplete(pair);
    };
    const request = this.buildRequest({
      nominate: true,
      localUsername: pair.localCandidate.ufrag ?? this.localUsername,
      remoteUsername: this.remoteUsername,
      iceControlling: this.iceControlling,
      localCandidate: pair.localCandidate,
    });
    if (!this.decorateSpedRequest(request, pair)) {
      fail();
      return;
    }
    pair.requestsSent++;

    try {
      const [response, addr] = await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(this.remotePassword, "utf8"),
        { ...this.checkRequestOptions(pair), signal: this.remoteChecks.signal },
      );
      if (this.isStaleNomination(pair, generation)) {
        return;
      }
      if (!this.bindingResponseSourceMatches(addr, pair)) {
        fail();
        return;
      }
      pair.responsesReceived++;
      this.spedRuntime?.tryMarkDirectHandshakeReady(pair, generation);
      await this.consumeSpedStun(
        response,
        addr,
        pair.protocol,
        pair,
        generation,
      );
      if (this.isStaleNomination(pair, generation)) {
        return;
      }
    } catch (error) {
      if (this.isStaleNomination(pair, generation)) {
        return;
      }
      log("tcp nomination failed", pair.toJSON(), error);
      fail();
      return;
    }
    pair.nominated = true;
    this.nominating = false;
    this.checkComplete(pair);
  }

  /** The agent was closed or restarted while the nomination was in flight. */
  private isStaleNomination(pair: CandidatePair, generation: number) {
    return (
      this.state === "closed" ||
      this.remoteGeneration !== generation ||
      !this.checkList.includes(pair)
    );
  }

  private addPair(pair: CandidatePair) {
    this.checkList.push(pair);
    this.sortCheckList();
    this.incomingPairWait?.settle(true);
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

    if (this.iceLite) {
      if (
        message.attributesKeys.includes("USE-CANDIDATE") &&
        !this.iceControlling
      ) {
        pair.remoteNominated = true;
        pair.nominated = true;
        pair.updateState(CandidatePairState.SUCCEEDED);
        this.checkComplete(pair);
        this.spedRuntime?.tryMarkDirectHandshakeReady(pair, this.generation);
      }
      return;
    }

    // 7.2.1.4.  Triggered Checks
    if (
      [CandidatePairState.WAITING, CandidatePairState.FAILED].includes(
        pair.state,
      )
    ) {
      pair.handle = this.checkStart(pair);
    }

    // 7.2.1.5. Updating the Nominated Flag
    if (
      message.attributesKeys.includes("USE-CANDIDATE") &&
      !this.iceControlling
    ) {
      pair.remoteNominated = true;
      if (pair.state === CandidatePairState.SUCCEEDED) {
        pair.nominated = true;
        this.checkComplete(pair);
      }
    }
  }

  private tryPair(protocol: Protocol, remoteCandidate: Candidate) {
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
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
  }

  /**
   * Pair a local candidate gathered after remote candidates arrived (a late
   * TURN allocation, a slow host socket) with them.
   */
  private pairLocalProtocol(protocol: Protocol) {
    // RFC 8445 §8.1.2: once a pair is selected, the check list takes no more
    // Waiting pairs, so a candidate gathered later starts no check.
    if (this.nominated || this.checkListDone || this.state === "closed") {
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

  private buildRequest({
    nominate,
    remoteUsername,
    localUsername,
    iceControlling,
    localCandidate,
  }: {
    nominate: boolean;
    remoteUsername: string;
    localUsername: string;
    iceControlling: boolean;
    localCandidate?: Candidate;
  }) {
    const txUsername = encodeTxUsername({ remoteUsername, localUsername });
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", txUsername).setAttribute(
      "PRIORITY",
      candidatePriority("prflx", {
        transport: localCandidate?.transport,
        tcptype: localCandidate?.tcptype,
      }),
    );
    if (iceControlling) {
      request.setAttribute("ICE-CONTROLLING", this.tieBreaker);
      if (nominate) {
        request.setAttribute("USE-CANDIDATE", null);
      }
    } else {
      request.setAttribute("ICE-CONTROLLED", this.tieBreaker);
    }
    return request;
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
      .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
      .addFingerprint();
    protocol.sendStun(response, addr).catch((e) => {
      log("sendStun error", e);
    });
  }
}

const encodeTxUsername = ({
  remoteUsername,
  localUsername,
}: {
  remoteUsername: string;
  localUsername: string;
}) => {
  return `${remoteUsername}:${localUsername}`;
};

const decodeTxUsername = (txUsername: string) => {
  const [remoteUsername, localUsername] = txUsername.split(":");
  return { remoteUsername, localUsername };
};

type ProvisionalGeneration = {
  localUsername: string;
  localPassword: string;
  remoteUsername?: string;
  remotePassword?: string;
  remoteCandidates: Candidate[];
  remoteCandidatesEnd: boolean;
  /** End-of-candidates arrived; waiting for earlier mDNS resolutions. */
  remoteCandidatesEndRequested: boolean;
  resolutions: Set<Promise<string>>;
  /** Incremented when a replacement pranswer restarts this checklist. */
  revision: number;
  pairs: CandidatePair[];
  nominated?: CandidatePair;
  /** A regular nomination (toward an ICE-lite peer) is in flight. */
  nominating?: boolean;
  started: boolean;
  /** Aborts the checks in flight when the checklist is replaced or dropped. */
  checks: AbortController;
};
