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
import {
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
  defaultOptions,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  isCandidateAllowedByGatherOptions,
  isRelayOnlyGathering,
  mergeIceServerOptions,
  serverReflexiveCandidate,
  sortCandidatePairs,
  validateAddress,
  validateRemoteCandidate,
} from "./iceBase";
import { type Address, debug, Event, interfaceAddress } from "./imports/common";
import { resolveHostAddresses } from "./internal/resolveHostAddresses";
import { classes, methods, TCP_CHECK_RESPONSE_TIMEOUT_MS } from "./stun/const";
import { Message } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import {
  createStunOverTurnClient,
  StunOverTurnProtocol,
} from "./turn/protocol";
import type { Protocol, TransactionRequestOptions } from "./types/model";
import { getHostAddresses } from "./utils";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

/** Fallback STUN server when none is configured (constructor / setIceServers). */
const DEFAULT_STUN_SERVER: Address = ["stun.l.google.com", 19302];

/** Default of `IceOptions.nominationDelayMs`. */
const DEFAULT_NOMINATION_DELAY_MS = 300;
/**
 * USE-CANDIDATE transactions sent for one pair before an unanswered
 * nomination gives up (each one retransmits as a check does).
 */
const NOMINATION_ATTEMPTS = 3;
/**
 * Check-list result: an unanswered nomination was abandoned. Unlike
 * ICE_FAILED (which connect() keeps waiting past, as more candidates may
 * still pair), it ends connect() with an error.
 */
const ICE_NOMINATION_ABANDONED = 3;
/**
 * How long, from the start of its checks, the live checklist waits for the pair
 * a provisional nomination may have selected (`NominationHint`) to appear.
 * It can appear after end-of-candidates: a peer-reflexive or passive TCP
 * pair forms only when the peer's check arrives. Covers the peer's check
 * pacing and a TCP check's response timeout (`TCP_CHECK_RESPONSE_TIMEOUT_MS`).
 */
const PREFERRED_PAIR_WAIT_MS = 3000;

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
  /** The ICE-lite nomination (first valid pair, in `checkStart`) is in flight. */
  private liteNominating = false;
  /** Regular nomination (RFC 8445 §8.1.1) of the live checklist. */
  private readonly nomination = new RegularNomination(
    this.liveNominationHost(),
  );
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
   * - `checkProvisional` / `nominateProvisional`: `generation.checks`
   *   (`endProvisional()`, a replacement pranswer, close); `belongs()`, and
   *   the provisional `RegularNomination` as above.
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
    // Server fields are assigned even when undefined, so a STUN-only update
    // or an unset TLS / address-family option leaves nothing behind.
    this.options = mergeIceServerOptions(this.options, options);
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
    this.generation++;
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
    this.liteNominating = false;
    // Taken before endProvisional() drops the provisional checklist.
    const hint = this.provisionalNominationHint();
    this.nomination.reset();
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
    this.stopConsentLifecycle();
    this.endProvisional();
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
    this.nominationHint = undefined;
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
    if (this.provisional) {
      this.provisional.checks.abort();
      this.provisional.nomination.reset();
    }
    this.provisional = undefined;
  }

  /** Accept provisional checks without changing the selected current pair. */
  stageLocalCredentials(
    usernameFragment: string,
    password: string,
    gatherOptions?: Partial<IceOptions>,
  ) {
    this.userHistory[usernameFragment] = password;
    this.endProvisional();
    const generation: ProvisionalGeneration = {
      localUsername: usernameFragment,
      localPassword: password,
      gatherOptions,
      remoteCandidates: [],
      remoteCandidatesEnd: false,
      remoteCandidatesEndRequested: false,
      resolutions: new Set(),
      revision: 0,
      pairs: [],
      nomination: new RegularNomination(
        this.provisionalNominationHost(() => generation),
      ),
      started: false,
      checks: new AbortController(),
    };
    this.provisional = generation;
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
    generation.liteNominating = false;
    generation.nomination.reset();
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
      generation.nomination.evaluate();
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
      if (!this.isUncheckedPair(pair)) {
        void this.checkProvisional(generation, pair);
      }
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
      !this.allowsProvisional(generation, protocol) ||
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
    this.addProvisionalPair(generation, pair);
    // As the live schedule does, forceTurn leaves host pairs unchecked.
    if (generation.started && !this.isUncheckedPair(pair)) {
      void this.checkProvisional(generation, pair);
    }
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
    // Regular nomination: a check never carries USE-CANDIDATE; the
    // nomination is a separate check (`generation.nomination`).
    const request = this.buildRequest({
      nominate: false,
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
        generation.nomination.evaluate();
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
      generation.nomination.evaluate();
      return;
    }
    // Only a controlled agent takes the peer's nomination (see checkStart).
    if (pair.remoteNominated && !this.iceControlling) pair.nominated = true;
    pair.updateState(CandidatePairState.SUCCEEDED);
    if (
      !pair.nominated &&
      this.iceControlling &&
      this.remoteIsLite &&
      !generation.nominated &&
      !generation.liteNominating
    ) {
      // Toward an ICE-lite peer, as the live checklist does: nominate the
      // first pair that succeeded with a check that carries USE-CANDIDATE.
      generation.liteNominating = true;
      const result = await this.nominateProvisional(
        generation,
        pair,
        generation.checks.signal,
      );
      if (belongs()) {
        generation.liteNominating = false;
        if (result === "nominated") pair.nominated = true;
      }
    }
    if (pair.nominated && !generation.nominated) {
      log("provisional nominated", pair.toJSON());
      generation.nominated = pair;
      generation.nomination.stop();
      return;
    }
    if (belongs()) generation.nomination.evaluate();
  }

  /** Put `pair` on the provisional checklist (see `addPair`). */
  private addProvisionalPair(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
  ) {
    const best = this.bestValidPair(generation.pairs);
    generation.pairs.push(pair);
    generation.nomination.pairAdded(pair, best);
  }

  /**
   * The provisional checklist's side of regular nomination: the same rules
   * as the live checklist (`liveNominationHost`), on its own pairs,
   * credentials and end-of-candidates.
   */
  private provisionalNominationHost(
    generationOf: () => ProvisionalGeneration,
  ): NominationHost {
    const current = () => this.provisional === generationOf();
    return {
      active: () =>
        current() &&
        this.usesRegularNomination() &&
        generationOf().started &&
        !generationOf().nominated,
      checking: () => generationOf().started,
      pairs: () => {
        const pairs = [...generationOf().pairs];
        sortCandidatePairs(pairs, this.iceControlling);
        return pairs;
      },
      remoteCandidatesEnd: () => generationOf().remoteCandidatesEnd,
      localCandidatesEnd: () => this.localCandidatesEnd,
      delayMs: () => this.nominationDelayMs,
      unchecked: (pair) => this.isUncheckedPair(pair),
      outranks: (pair, other) => this.outranks(pair, other),
      preferred: () => undefined,
      owns: (pair) => current() && generationOf().pairs.includes(pair),
      send: (pair, signal) =>
        this.nominateProvisional(
          generationOf(),
          pair,
          AbortSignal.any([generationOf().checks.signal, signal]),
        ),
      nominated: (pair) => {
        const generation = generationOf();
        pair.nominated = true;
        if (!generation.nominated) {
          log("provisional nominated", pair.toJSON());
          generation.nominated = pair;
        }
      },
      rejected: (pair) => {
        pair.updateState(CandidatePairState.FAILED);
        generationOf().nomination.evaluate();
      },
      // As in the live checklist: become controlled, keep the pair valid.
      roleConflict: () => this.switchRole(false),
      abandoned: (pair) => pair?.updateState(CandidatePairState.FAILED),
    };
  }

  /**
   * Send a USE-CANDIDATE check for a provisional `pair` (see
   * `NominationOutcome`). `signal` stops it: the checklist's checks
   * (endProvisional, a replacement pranswer) and, for regular nomination,
   * the attempt.
   */
  private async nominateProvisional(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
    signal: AbortSignal,
  ): Promise<NominationOutcome> {
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
          signal,
        },
      );
      pair.responsesReceived++;
      return "nominated";
    } catch (error) {
      log("provisional regular nomination failed", error);
      if (isRoleConflict(error)) return "role-conflict";
      return error instanceof TransactionTimeout ? "unanswered" : "rejected";
    }
  }

  /** Incoming check for the provisional ufrag; never touches the current checklist. */
  private checkIncomingProvisional(
    generation: ProvisionalGeneration,
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) {
    // A socket the staged generation drops at the commit takes no pair.
    if (!this.allowsProvisional(generation, protocol)) return;
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
      this.addProvisionalPair(generation, pair);
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
    this.nomination.evaluate();
  }

  resetNominatedPair() {
    log("resetNominatedPair");
    this.nominated = undefined;
    this.liteNominating = false;
    this.nomination.reset();
    this.nominationHint = undefined;
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

      // A family bound to an explicit interface address gathers only that
      // address, so the advertised host candidate is the socket's address.
      const address = resolveHostAddresses({
        enumerated: getHostAddresses(
          this.options.useIpv4,
          this.options.useIpv6,
          {
            useLinkLocalAddress: this.options.useLinkLocalAddress,
          },
        ),
        interfaceAddresses: this.options.interfaceAddresses,
        additionalHostAddresses: this.options.additionalHostAddresses,
        useIpv4: this.options.useIpv4,
        useIpv6: this.options.useIpv6,
        log,
      });

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
      this.nomination.evaluate();
      this.provisional?.nomination.evaluate();
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

  /**
   * Whether the provisional generation may use `protocol`: the staged
   * generation drops the sockets its gather options exclude at the commit,
   * so its checks never use them. A kept TURN allocation serves it only when
   * the generation still uses that TURN server and credential: one whose
   * server was removed or replaced (a credential rotation) is not part of it.
   */
  private allowsProvisional(
    generation: ProvisionalGeneration,
    protocol: Protocol,
  ) {
    const options = generation.gatherOptions ?? this.options;
    if (
      !protocol.localCandidate ||
      !isCandidateAllowedByGatherOptions(protocol.localCandidate, options)
    ) {
      return false;
    }
    if (protocol instanceof StunOverTurnProtocol) {
      const { configuredServer, username, password } = protocol.turn;
      const turnServer = validateAddress(options.turnServer);
      return (
        !!turnServer &&
        configuredServer[0] === turnServer[0] &&
        configuredServer[1] === turnServer[1] &&
        username === options.turnUsername &&
        password === options.turnPassword
      );
    }
    return true;
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
      if (msg.messageMethod !== methods.BINDING) {
        this.respondError(msg, addr, protocol, [400, "Bad Request"]);
        return;
      }

      const txUsername = msg.getAttributeValue("USERNAME");
      // 相手にとってのremoteは自分にとってのlocal
      const { remoteUsername: localUsername } = decodeTxUsername(txUsername);
      const localPassword =
        this.userHistory[localUsername] ?? this.localPassword;

      // A check for the staged generation on a socket it drops at the commit
      // (a host socket under a relay-only policy, a TURN allocation whose
      // server was removed or replaced) is not answered: the socket is not
      // part of that generation.
      const staged = this.provisional;
      if (
        staged &&
        localUsername === staged.localUsername &&
        localUsername !== this.localUsername &&
        !this.allowsProvisional(staged, protocol)
      ) {
        return;
      }

      const { iceControlling } = this;

      // 7.2.1.1.  Detecting and Repairing Role Conflicts
      if (iceControlling && msg.attributesKeys.includes("ICE-CONTROLLING")) {
        if (this.tieBreaker >= msg.getAttributeValue("ICE-CONTROLLING")) {
          this.respondError(
            msg,
            addr,
            protocol,
            [487, "Role Conflict"],
            localPassword,
          );
          return;
        } else {
          this.switchRole(false);
        }
      } else if (
        !iceControlling &&
        msg.attributesKeys.includes("ICE-CONTROLLED")
      ) {
        if (
          this.iceLite ||
          this.tieBreaker < msg.getAttributeValue("ICE-CONTROLLED")
        ) {
          this.respondError(
            msg,
            addr,
            protocol,
            [487, "Role Conflict"],
            localPassword,
          );
          return;
        } else {
          this.switchRole(true);
          return;
        }
      }

      if (
        this.options.filterStunResponse &&
        !this.options.filterStunResponse(msg, addr, protocol)
      ) {
        return;
      }

      // # send binding response
      const response = new Message(
        methods.BINDING,
        classes.RESPONSE,
        msg.transactionId,
      );

      response
        .setAttribute("XOR-MAPPED-ADDRESS", addr)
        .addMessageIntegrity(Buffer.from(localPassword, "utf8"))
        .addFingerprint();
      protocol.sendStun(response, addr).catch((e) => {
        log("sendStun error", e);
      });

      const provisional = this.provisional;
      if (
        provisional &&
        localUsername === provisional.localUsername &&
        localUsername !== this.localUsername
      ) {
        this.checkIncomingProvisional(provisional, msg, addr, protocol);
        return;
      }

      if (this.checkList.length === 0 && !this.earlyChecksDone) {
        this.earlyChecks.push([msg, addr, protocol]);
      } else {
        this.checkIncoming(msg, addr, protocol);
      }
    });
    protocol.onDataReceived.subscribe((data) => {
      try {
        // Update statistics for the nominated pair
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
    const { turnUsername, turnPassword, interfaceAddresses } = this.options;
    const gatherIceLite = this.iceLite;
    const gatherRelayOnly = isRelayOnlyGathering(this.options);

    // TCP host candidates are kept per address like the UDP ones, but on
    // their own: a restart that turned useTcp on gathers them for addresses
    // whose UDP sockets were kept.
    const tcpAddresses = addresses.filter(
      (address) =>
        !this.protocols.some(
          (protocol) =>
            protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
            protocol.localIp === address,
        ),
    );
    addresses = addresses.filter((address) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      if (this.protocols.find((protocol) => protocol.localIp === address)) {
        return false;
      }
      // A family bound to an interface address has one UDP host socket; its
      // localIp is the bound address, whose notation may differ (IPv6).
      if (
        interfaceAddress(socketTypeOf(address), interfaceAddresses) ===
          address &&
        this.protocols.some(
          (protocol) =>
            protocol instanceof StunProtocol &&
            protocol.localCandidate?.type === "host" &&
            isIPv4(protocol.localCandidate.host) === isIPv4(address),
        )
      ) {
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
          const boundInterface = interfaceAddress(
            socketTypeOf(address),
            interfaceAddresses,
          );
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.options.portRange,
              interfaceAddresses,
            );
            if (stale()) {
              await protocol.close();
              return;
            }

            // # add host candidate
            // A socket bound to an interface address advertises that address:
            // the peer sends its checks there. A wildcard socket advertises
            // the gathered address (never 0.0.0.0 / ::).
            const [boundHost, boundPort] = protocol.getExtraInfo();
            let candidateHost = address;
            if (boundInterface) {
              candidateHost = stripZoneId(boundHost);
              if (candidateHost !== address) {
                log(
                  "host address differs from the bound interface address; advertise the bound one",
                  address,
                  candidateHost,
                );
              }
            }
            const candidateAddress: Address = [candidateHost, boundPort];

            protocol.localIp = candidateHost;
            this.protocols.push(protocol);

            log("protocol", protocol.localIp);

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
            if (boundInterface) {
              // No host candidate for this family: advertising another
              // address than the socket's would mislead the peer.
              log(
                "failed to bind UDP socket to interface address",
                boundInterface,
                error,
              );
            } else {
              log("error protocol STUN", error);
            }
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
      const tcpCandidatePromises = tcpAddresses.map(async (address) => {
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
        // The related address of a relay candidate is the address the TURN
        // server saw the agent at. A relay-only policy hides the agent's
        // addresses from the peer, so it advertises the unspecified address
        // and port 9 instead (RFC 8839 §5.1), in SDP and trickle alike.
        const relatedAddress: Address = gatherRelayOnly
          ? [isIPv4(candidateAddress[0]) ? "0.0.0.0" : "::", 9]
          : protocol.turn.mappedAddress;

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
    }
    this.earlyChecks = [];
    this.earlyChecksDone = true;
    // Arms the wait for a preferred pair even while the checklist is empty.
    this.nomination.evaluate();

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
    // The nomination may still wait for a pair an incoming check forms
    // (`NominationHint`), even with an empty checklist.
    while (
      (this.checkList.length > 0 || this.nomination.waiting) &&
      res === ICE_FAILED
    ) {
      res = await this.checkListState.get();
      log("checkListState", res);
    }

    // # cancel remaining checks
    for (const check of this.checkList) {
      check.handle?.resolve?.();
    }

    if (res !== ICE_COMPLETED) {
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
    return this.consentFresh;
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
          const generation = this.remoteGeneration;
          const remotePassword = this.remotePassword;
          const { localUsername, remoteUsername, iceControlling } = this;

          const request = this.buildRequest({
            nominate: this.shouldNominateConsentRequest(nominated),
            localUsername,
            remoteUsername,
            iceControlling,
            localCandidate: nominated.localCandidate,
          });

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
            .then(() => {
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
              if (this.remoteGeneration !== generation) {
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
    this.liteNominating = false;
    this.nomination.reset();
    this.nominationHint = undefined;
    for (const protocol of this.protocols) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];

    this.lookup?.close?.();
    this.lookup = undefined;
  }

  private setState(state: IceState) {
    this.state = state;
    this.stateChanged.execute(state);
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
      this.nomination.evaluate();
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
    this._remoteCandidates.push(remoteCandidate);

    this.pairRemoteCandidate(remoteCandidate);
    this.sortCheckList();
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

  private applyIceControlling(iceControlling: boolean) {
    const becameControlling = !this._iceControlling && iceControlling;
    if (this._iceControlling !== iceControlling) {
      this.invalidateNominations();
      // USE-CANDIDATE received while controlled came from a peer that was
      // controlling then; as the controlling agent this one nominates itself.
      if (iceControlling) {
        for (const pair of [
          ...this.checkList,
          ...(this.provisional?.pairs ?? []),
        ]) {
          pair.remoteNominated = false;
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
    if (!this.usesRegularNomination()) return;
    const live = this.nominated;
    if (live && this.state !== "closed" && this.checkList.includes(live)) {
      void this.confirmSelection(
        (signal) => this.sendNomination(live, signal),
        () => this.nominated === live && this.state !== "closed",
      );
    }
    const generation = this.provisional;
    const provisional = generation?.nominated;
    if (generation && provisional && generation.pairs.includes(provisional)) {
      void this.confirmSelection(
        (signal) =>
          this.nominateProvisional(
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
  }

  private checkComplete(pair: CandidatePair) {
    pair.handle = undefined;
    if (pair.state === CandidatePairState.SUCCEEDED) {
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
        this.liteNominating = false;
        this.nomination.stop();
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

    this.nomination.evaluate();

    this.failCheckListIfExhausted();
  }

  /**
   * Report ICE_FAILED once no pair can succeed or be nominated any more.
   * Also evaluated when the nomination delay ends without a valid pair.
   */
  private failCheckListIfExhausted() {
    // A nomination request is still in flight, or the controlling agent waits
    // to nominate a valid pair: that decides the outcome.
    if (
      this.nominated ||
      this.liteNominating ||
      this.nomination.inFlight ||
      this.nomination.waiting
    ) {
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
      const result: { response?: Message; addr?: Address } = {};
      const { remotePassword, remoteUsername, generation } = this;
      const localUsername = pair.localCandidate.ufrag ?? this.localUsername;

      // Regular nomination (RFC 8445 §8.1.1): an ordinary check never
      // carries USE-CANDIDATE; see RegularNomination.
      const request = this.buildRequest({
        nominate: false,
        localUsername,
        remoteUsername,
        iceControlling: this.iceControlling,
        localCandidate: pair.localCandidate,
      });

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
      } catch (error: any) {
        // A cancelled check (its handle resolved, or the agent closed and
        // cancelled its transactions) changes nothing.
        if (signal.aborted || error instanceof TransactionCancelled) {
          r();
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
        try {
          pair.requestsSent++;
          await pair.protocol.request(
            request,
            pair.remoteAddr,
            Buffer.from(this.remotePassword, "utf8"),
            { ...this.checkRequestOptions(pair), signal },
          );
          pair.responsesReceived++;
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
   * Full ICE on both sides: the controlling agent uses regular nomination
   * (RFC 8445 §8.1.1) for every transport. A check that succeeds only makes
   * its pair valid; `RegularNomination` later picks one valid pair and
   * nominates it with a separate USE-CANDIDATE check. Nominating the first
   * pair that succeeds (aggressive nomination) would let a lower-priority
   * candidate that happened to finish first (TURN/TCP) win over a
   * higher-priority one trickled moments later (TURN/UDP), and with TCP the
   * two sides could settle on different connections.
   */
  private usesRegularNomination() {
    return this.iceControlling && !this.remoteIsLite && !this.iceLite;
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
        this.usesRegularNomination() &&
        !this.nominated &&
        this.state !== "closed",
      checking: () => this.checksBegun,
      pairs: () => this.checkList,
      remoteCandidatesEnd: () => this.remoteCandidatesEnd,
      localCandidatesEnd: () => this.localCandidatesEnd,
      delayMs: () => this.nominationDelayMs,
      unchecked: (pair) => this.isUncheckedPair(pair),
      outranks: (pair, other) => this.outranks(pair, other),
      preferred: () => {
        const hint = this.nominationHint;
        if (
          !hint ||
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
      deadlinePassed: () => this.failCheckListIfExhausted(),
    };
  }

  /** Send the USE-CANDIDATE check for a live `pair` (see `NominationOutcome`). */
  private async sendNomination(
    pair: CandidatePair,
    signal: AbortSignal,
  ): Promise<NominationOutcome> {
    const request = this.buildRequest({
      nominate: true,
      localUsername: pair.localCandidate.ufrag ?? this.localUsername,
      remoteUsername: this.remoteUsername,
      iceControlling: this.iceControlling,
      localCandidate: pair.localCandidate,
    });
    pair.requestsSent++;
    try {
      await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(this.remotePassword, "utf8"),
        {
          ...this.checkRequestOptions(pair),
          signal: AbortSignal.any([this.remoteChecks.signal, signal]),
        },
      );
      pair.responsesReceived++;
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
    this.nomination.pairAdded(pair, best);
  }

  // 7.2.  STUN Server Procedures
  // 7.2.1.3、7.2.1.4、および7.2.1.5
  checkIncoming(message: Message, addr: Address, protocol: Protocol) {
    // """
    // Handle a successful incoming check.
    // """

    const txUsername = message.getAttributeValue("USERNAME");
    const { remoteUsername: localUsername } = decodeTxUsername(txUsername);

    // find remote candidate
    let remoteCandidate: Candidate | undefined;
    const [host, port] = addr;
    for (const c of this.remoteCandidates) {
      if (c.host === host && c.port === port) {
        remoteCandidate = c;
        break;
      }
    }
    if (!remoteCandidate) {
      // 7.2.1.3.  Learning Peer Reflexive Candidates
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

    // find pair
    let pair = this.findPair(protocol, remoteCandidate);
    if (!pair) {
      pair = new CandidatePair(protocol, remoteCandidate, this.iceControlling);
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(pair);
    }
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

/** The peer answered with 487 (Role Conflict). */
const isRoleConflict = (error: unknown) =>
  (error as TransactionError | undefined)?.response?.getAttributeValue(
    "ERROR-CODE",
  )?.[0] === 487;

type NominationDecision =
  | { action: "nominate"; pair: CandidatePair }
  | { action: "wait"; deadline: number }
  /** The pair the peer may have selected cannot be nominated: nominate nothing else. */
  | { action: "abandon"; pair?: CandidatePair }
  | { action: "none" };

/**
 * RFC 8445 §8.1.1 regular nomination: when the controlling agent stops
 * checking and nominates, shared by the live and the provisional checklist.
 *
 * - With a `preferred` rule (the peer may have selected that path already,
 *   see `NominationHint`), only the matching pair may be nominated: as soon
 *   as it is valid, waited for while its check runs. When it fails, or is not
 *   in the checklist `PREFERRED_PAIR_WAIT_MS` (at least the delay) after the
 *   checklist began, even after end-of-candidates or with no other valid
 *   pair, the nomination is
 *   abandoned (as an unanswered one is):
 *   nominating another pair could leave the agents on different paths.
 * - The candidate is the first valid (Succeeded) pair of `pairs` (priority
 *   order, highest first), so the choice is deterministic.
 * - Nominate at once when both sides signalled end-of-candidates and no
 *   higher-priority pair can still succeed.
 * - Otherwise wait until `quietSince + delayMs`, then nominate anyway: a
 *   higher-priority pair still in progress (an unreachable host pair takes
 *   seconds to fail) or a peer that never signals end-of-candidates must not
 *   hold the selection back longer than that.
 */
const decideNomination = ({
  pairs,
  remoteCandidatesEnd,
  localCandidatesEnd,
  quietSince,
  delayMs,
  now,
  unchecked,
  preferred,
  preferredSince,
}: {
  pairs: readonly CandidatePair[];
  remoteCandidatesEnd: boolean;
  localCandidatesEnd: boolean;
  quietSince: number | undefined;
  delayMs: number;
  now: number;
  /** Pairs never checked locally, which cannot be waited for. */
  unchecked: (pair: CandidatePair) => boolean;
  preferred: ((pair: CandidatePair) => boolean) | undefined;
  /** When the checklist began waiting for the `preferred` pair. */
  preferredSince: number | undefined;
}): NominationDecision => {
  if (preferred) {
    const hinted = pairs.find(preferred);
    if (hinted?.state === CandidatePairState.SUCCEEDED) {
      return { action: "nominate", pair: hinted };
    }
    if (hinted) {
      if (hinted.state === CandidatePairState.FAILED || unchecked(hinted)) {
        return { action: "abandon", pair: hinted };
      }
      // Its check finishing re-evaluates the nomination.
      return { action: "none" };
    }
    // Not (yet) in the checklist. End-of-candidates does not settle it, nor
    // does an empty checklist: a peer-reflexive pair (or a passive TCP one) is
    // only formed when the peer's check arrives, so wait for it a bounded time
    // from when the checklist began.
    const deadline =
      (preferredSince ?? now) + Math.max(delayMs, PREFERRED_PAIR_WAIT_MS);
    if (now >= deadline) return { action: "abandon" };
    return { action: "wait", deadline };
  }
  const index = pairs.findIndex(
    (pair) => pair.state === CandidatePairState.SUCCEEDED,
  );
  if (index === -1) return { action: "none" };
  const pair = pairs[index];
  const pendingAbove = pairs
    .slice(0, index)
    .some(
      (above) => above.state !== CandidatePairState.FAILED && !unchecked(above),
    );
  if (remoteCandidatesEnd && localCandidatesEnd && !pendingAbove) {
    return { action: "nominate", pair };
  }
  const deadline = (quietSince ?? now) + delayMs;
  if (now >= deadline) return { action: "nominate", pair };
  return { action: "wait", deadline };
};

/** What a USE-CANDIDATE check came back with. */
type NominationOutcome =
  /** Answered with success. */
  | "nominated"
  /** Timed out: the request may have reached the peer, which may have selected the pair. */
  | "unanswered"
  /** An error response, or the request never left (e.g. a refused TCP connect). */
  | "rejected"
  /** 487: the peer is controlling too and wins (RFC 8445 §7.2.5.1). */
  | "role-conflict";

/** What a checklist (live or provisional) supplies to its `RegularNomination`. */
type NominationHost = {
  /** The controlling agent nominates in this checklist now (full ICE on both sides, nothing nominated yet, the checklist still current). */
  active: () => boolean;
  /** The checklist's checks began (connect(), startProvisionalChecks()). */
  checking: () => boolean;
  /** The checklist, highest priority first. */
  pairs: () => readonly CandidatePair[];
  remoteCandidatesEnd: () => boolean;
  localCandidatesEnd: () => boolean;
  delayMs: () => number;
  /** Pairs never checked locally (forceTurn), which cannot be waited for. */
  unchecked: (pair: CandidatePair) => boolean;
  outranks: (pair: CandidatePair, other: CandidatePair) => boolean;
  /** Matches the only pair that may be nominated: the peer may have selected it already (see `NominationHint`). */
  preferred: () => ((pair: CandidatePair) => boolean) | undefined;
  /** A result for `pair` still applies: the pair is in the checklist and the agent open. */
  owns: (pair: CandidatePair) => boolean;
  /** Send the USE-CANDIDATE check; never rejects. */
  send: (
    pair: CandidatePair,
    signal: AbortSignal,
  ) => Promise<NominationOutcome>;
  nominated: (pair: CandidatePair) => void;
  /** The peer refused the pair: fail it, so the next valid pair is nominated. */
  rejected: (pair: CandidatePair) => void;
  roleConflict: (pair: CandidatePair) => void;
  /**
   * No attempt on a pair the peer may have selected was answered, or that
   * pair (the hint) failed or never appeared (`pair` undefined).
   */
  abandoned: (pair?: CandidatePair) => void;
  /** The delay ended (after the re-evaluation it triggers). */
  deadlinePassed?: () => void;
};

/**
 * The regular nomination (RFC 8445 §8.1.1) of one checklist: the single
 * state and rule set the live checklist and the provisional (ICE-restart)
 * checklist share. It holds the delay, the USE-CANDIDATE attempt in flight,
 * its repeats and the abandoned state; the checklist supplies the pairs and
 * applies the outcome (`NominationHost`).
 *
 * - Delay: `quietSince` is the first valid pair, moved forward by every pair
 *   added later that outranks the best valid pair and is checked locally
 *   (a forceTurn-excluded pair cannot replace it and does not count).
 * - One attempt at a time; a result whose attempt is no longer current (a
 *   restart, a replacement pranswer, close or a role change replaced it) is
 *   ignored and its transaction aborted.
 * - An unanswered attempt may have been accepted: it is repeated on the same
 *   pair (never another), also when a repeat is answered with an error. When
 *   all `NOMINATION_ATTEMPTS` go unanswered nothing else is nominated.
 * - An error answering the first attempt: only that pair fails.
 */
class RegularNomination {
  private quietSince?: number;
  /** The checklist began waiting for the preferred pair (see `decideNomination`). */
  private preferredSince?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private attempt?: { pair: CandidatePair; abort: AbortController };
  /** Every attempt went unanswered: no other pair is nominated until reset. */
  abandoned = false;
  /**
   * The pair a USE-CANDIDATE was sent to and the peer did not refuse: the
   * peer may have selected it (the provisional checklist hands it to the
   * live one at the final answer, see `NominationHint`).
   */
  maybeSelected?: CandidatePair;

  constructor(private readonly host: NominationHost) {}

  /** A USE-CANDIDATE transaction is in flight. */
  get inFlight() {
    return this.attempt !== undefined;
  }

  /** Waiting for the delay to end. */
  get waiting() {
    return this.timer !== undefined;
  }

  /** `pair` joined the checklist; `best` was its best valid pair before. */
  pairAdded(pair: CandidatePair, best: CandidatePair | undefined) {
    // A pair that may replace the best valid pair restarts the delay; a
    // lower-priority one, or one the agent never checks, cannot change the
    // choice and does not.
    if (best && !this.host.unchecked(pair) && this.host.outranks(pair, best)) {
      this.quietSince = Date.now();
      this.evaluate();
    }
  }

  /**
   * Nominate now, or arm the timer that re-evaluates at the deadline. Called
   * whenever the answer may change: a check finished, a pair was added,
   * end-of-candidates, the role changed, the timer fired.
   */
  evaluate() {
    if (!this.host.active() || this.attempt || this.abandoned) {
      this.stop();
      return;
    }
    const pairs = this.host.pairs();
    const now = Date.now();
    if (
      this.quietSince === undefined &&
      pairs.some((pair) => pair.state === CandidatePairState.SUCCEEDED)
    ) {
      this.quietSince = now;
    }
    const preferred = this.host.preferred();
    if (
      preferred &&
      this.preferredSince === undefined &&
      this.host.checking()
    ) {
      this.preferredSince = now;
    }
    const decision = decideNomination({
      pairs,
      remoteCandidatesEnd: this.host.remoteCandidatesEnd(),
      localCandidatesEnd: this.host.localCandidatesEnd(),
      quietSince: this.quietSince,
      delayMs: this.host.delayMs(),
      now,
      unchecked: this.host.unchecked,
      preferred,
      preferredSince: this.preferredSince,
    });
    this.stop();
    if (decision.action === "wait") {
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          this.evaluate();
          this.host.deadlinePassed?.();
        },
        Math.max(0, decision.deadline - now),
      );
    } else if (decision.action === "nominate") {
      this.nominate(decision.pair, 1, false);
    } else if (decision.action === "abandon") {
      log("preferred pair cannot be nominated, giving up");
      this.abandoned = true;
      this.host.abandoned(decision.pair);
    }
  }

  /** Stop waiting (a pair was nominated, or nomination is not possible now). */
  stop() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** The role changed: the attempt in flight was sent as the controlling agent and changes nothing after it. */
  invalidate() {
    this.attempt?.abort.abort();
    this.attempt = undefined;
    this.abandoned = false;
  }

  /** The checklist starts over (restart, replacement pranswer, renomination, close). */
  reset() {
    this.invalidate();
    this.stop();
    this.quietSince = undefined;
    this.preferredSince = undefined;
    this.maybeSelected = undefined;
  }

  /**
   * @param maybeAccepted an earlier attempt for `pair` went unanswered: the
   *   peer may have selected the pair already, so no later outcome lets the
   *   nomination move to another pair.
   */
  private nominate(
    pair: CandidatePair,
    attempt: number,
    maybeAccepted: boolean,
  ) {
    log("nominate", pair.toJSON(), { attempt, maybeAccepted });
    const current = { pair, abort: new AbortController() };
    this.attempt = current;
    this.maybeSelected = pair;
    void this.host.send(pair, current.abort.signal).then((outcome) => {
      if (this.attempt !== current) return;
      this.attempt = undefined;
      if (!this.host.owns(pair)) {
        // The pair left the checklist (another remote generation dropped).
        if (this.maybeSelected === pair) this.maybeSelected = undefined;
        this.evaluate();
        return;
      }
      if (outcome === "nominated") {
        this.stop();
        this.host.nominated(pair);
        return;
      }
      if (outcome === "role-conflict") {
        // The peer did not accept it as controlled; it nominates now.
        log("nomination role conflict", pair.toJSON());
        if (!maybeAccepted) this.maybeSelected = undefined;
        this.host.roleConflict(pair);
        return;
      }
      if (outcome === "unanswered" || maybeAccepted) {
        if (attempt < NOMINATION_ATTEMPTS) {
          log("nomination unanswered, repeating", pair.toJSON(), { attempt });
          this.nominate(pair, attempt + 1, true);
          return;
        }
        log("nomination unanswered, giving up", pair.toJSON());
        this.abandoned = true;
        this.stop();
        this.host.abandoned(pair);
        return;
      }
      log("nomination rejected", pair.toJSON());
      this.maybeSelected = undefined;
      this.host.rejected(pair);
    });
  }
}

/**
 * The pair the controlling agent may have nominated in the provisional
 * checklist when a final answer replaced it with the live one. The peer
 * may have selected that pair already: a USE-CANDIDATE retransmission can
 * reach its live checklist (same credentials) after it committed the
 * answer, and a peer that keeps the ICE session across pranswer -> answer
 * (JSEP) keeps its provisional selection. The live checklist checks from
 * scratch (`[2.7-T4a]`) but nominates only the pair with the same 5-tuple;
 * when that pair fails or never appears it nominates nothing else and the
 * agent fails (see `decideNomination`). It only applies while the live
 * checklist uses the provisional credentials and the agent keeps the pair's
 * local socket (`protocol`); otherwise the usual rules choose the pair.
 */
type NominationHint = {
  localUsername: string;
  remoteUsername: string;
  remotePassword: string;
  key: string;
  /**
   * The local socket (or TURN allocation) of the pair. The hint holds only
   * while the agent keeps it: a commit that closes it (an ICE restart
   * allocates TURN afresh, gather options that exclude the socket) ends the
   * path for both agents, so no selection of the peer is left to match.
   */
  protocol: Protocol;
};

/** Local foundation and the 5-tuple: the same path in another checklist. */
const pairKey = (pair: CandidatePair) =>
  [
    pair.localCandidate.foundation,
    pair.localCandidate.transport.toLowerCase(),
    pair.localCandidate.host,
    pair.localCandidate.port,
    pair.remoteCandidate.transport.toLowerCase(),
    pair.remoteCandidate.host,
    pair.remoteCandidate.port,
  ].join(" ");

type ProvisionalGeneration = {
  localUsername: string;
  localPassword: string;
  /** The options the staged generation gathers with (stageLocalCredentials). */
  gatherOptions?: Partial<IceOptions>;
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
  /** The ICE-lite nomination (first valid pair) is in flight. */
  liteNominating?: boolean;
  /** Regular nomination toward a full ICE peer (shares the live rules). */
  nomination: RegularNomination;
  started: boolean;
  /** Aborts the checks in flight when the checklist is replaced or dropped. */
  checks: AbortController;
};

const socketTypeOf = (address: string) => (isIPv4(address) ? "udp4" : "udp6");

/** Candidates carry no IPv6 zone id (e.g. `fe80::1%eth0`). */
const stripZoneId = (address: string) => address.split("%")[0];
