import * as timers from "node:timers/promises";
import { randomBytes } from "crypto";
import { isIPv4, isIPv6 } from "net";
import {
  Candidate,
  candidateFoundation,
  candidatePriority,
  remoteTcpTypeForIncoming,
} from "./candidate";
import { ConsentFreshness } from "./consent";
import { MdnsLookup } from "./dns/lookup";
import {
  TransactionCancelled,
  type TransactionError,
  TransactionTimeout,
} from "./exceptions";
import { type FailoverHost, FailoverMonitor } from "./failover";
import { cancelable, PQueue, randomString } from "./helper";
import {
  BACKUP_UNKNOWN_RTT_RESPONSE_TIMEOUT,
  CandidatePair,
  CandidatePairState,
  compareCandidatePairPriority,
  consentResponseTimeoutMs,
  defaultOptions,
  FAILOVER_CONSENT_EXPIRED_GRACE,
  ICE_COMPLETED,
  ICE_FAILED,
  type IceConnection,
  type IceOptions,
  type IceState,
  isCandidateAllowedByGatherOptions,
  isRelayOnlyGathering,
  mergeIceServerOptions,
  normalizeIceServerOptions,
  serverReflexiveCandidate,
  sortCandidatePairs,
  type TurnServerOptions,
  validateRemoteCandidate,
} from "./iceBase";
import { type Address, debug, Event, interfaceAddress } from "./imports/common";
import {
  buildCheckRequest,
  type CheckRequestParams,
  decodeTxUsername,
  isRoleConflict,
  receivedNomination,
  responseIntegrityMode,
} from "./internal/checkMessages";
import {
  getDefaultRouteAddresses,
  getRouteSourceAddress,
} from "./internal/defaultRoute";
import {
  getAssignedInterfaceAddresses,
  getHostInterfaceAddresses,
} from "./internal/hostInterfaces";
import { hostLocalPreferences } from "./internal/hostPreference";
import {
  type HostAddress,
  HostAddressBind,
  normalizeIp,
  resolveHostAddresses,
} from "./internal/resolveHostAddresses";
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
import { classes, methods, TCP_CHECK_RESPONSE_TIMEOUT_MS } from "./stun/const";
import { Message } from "./stun/message";
import { StunProtocol } from "./stun/protocol";
import { TcpActiveProtocol, TcpPassiveProtocol } from "./stun/tcpProtocol";
import { createStunOverTurnClient } from "./turn/protocol";
import type { Protocol, TransactionRequestOptions } from "./types/model";

const log = debug("werift-ice : packages/ice/src/ice.ts : log");

/** Fallback STUN server when none is configured (constructor / setIceServers). */
const DEFAULT_STUN_SERVER: Address = ["stun.l.google.com", 19302];

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
  /** TURN servers gathering allocates on, one allocation each. */
  turnServers: Required<TurnServerOptions>[] = [];
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
    allows: (pair) => this.failoverAllows(pair),
    failoverReplaces: (pair) =>
      this.failoverNomination === pair ||
      (this.selectionDown() && this.failover.writable(pair)),
    nominationEnded: (pair) => {
      if (this.failoverNomination === pair) this.failoverNomination = undefined;
    },
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
    failover: {
      enabled: () => this.failoverEnabled(),
      liveness: (pair) => this.failover.livenessOf(pair),
      responded: (pair) => {
        this.failover.responded(pair);
        this.onLinkChanged();
      },
      unanswered: (pair) => {
        this.failover.unanswered(pair);
        this.onLinkChanged();
      },
      expired: () => {
        // No data may be sent any more, but a writable backup may still
        // take over (the controlling agent nominates it, a controlled one
        // waits for the peer to). The agent is `disconnected` meanwhile and
        // fails unless the selection moves within
        // FAILOVER_CONSENT_EXPIRED_GRACE (or once no writable backup is
        // left, updateLinkState). The expired pair is not checked any more:
        // it is used again only if selected anew.
        if (!this.failover.hasWritableBackup()) {
          this.failover.reset();
          return false;
        }
        this.startConsentExpiredGrace();
        this.onLinkChanged();
        return true;
      },
    },
  });
  /**
   * Failover of the selected pair without an ICE restart (see
   * `failoverEnabled`): the backup pairs it monitors and the liveness of
   * the selected one.
   */
  private readonly failover = new FailoverMonitor(this.failoverHost());
  /**
   * The pair a failover nomination (`evaluateFailover`) is sent for, until
   * its outcome. When it succeeds the selection moves to it even if the old
   * pair answered again meanwhile (the peer may already have taken the
   * nomination), and the old pair's socket is demoted (D4).
   */
  private failoverNomination?: CandidatePair;
  /**
   * The selected pair's consent expired while a backup was writable: the
   * agent fails when this fires unless the selection moved first
   * (FAILOVER_CONSENT_EXPIRED_GRACE).
   */
  private consentExpiredGrace?: ReturnType<typeof setTimeout>;
  /** The state `disconnected` replaced, restored when the selection works again. */
  private stateBeforeDisconnect?: IceState;
  /** ICE restart generation checked beside the selected current pair. */
  private readonly reflexiveBySocket = new WeakMap<Protocol, Candidate[]>();
  private readonly wildcardProtocols = new Map<4 | 6, StunProtocol>();
  private localCandidatesEndPromise?: Promise<void>;
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

  /** The staged ICE restart generation (`ProvisionalChecklist`). */
  private get provisional() {
    return this.provisionalChecklist.generation;
  }

  constructor(_iceControlling: boolean, options?: Partial<IceOptions>) {
    this._iceControlling = _iceControlling;
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
   * Derive Connection.stunServers / turnServers from this.options.
   * Shared by the constructor and setIceServers so both paths validate and
   * default identically.
   */
  private applyStunTurnServersFromOptions() {
    const { stunServers, turnServers } = normalizeIceServerOptions(
      this.options,
    );
    this.stunServers =
      stunServers.length > 0 || this.options.useDefaultStunServer === false
        ? stunServers
        : [DEFAULT_STUN_SERVER];
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
    this.provisionalChecklist.end();
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
    this.failover.reset();
    this.clearConsentExpiredGrace();
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
    this.failover.reset();
    this.clearConsentExpiredGrace();
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
      for (const [family, wildcard] of this.wildcardProtocols) {
        if (!this.protocols.includes(wildcard)) {
          // Closed with the excluded sockets, or still opening for the
          // replaced generation: a fresh one is opened if needed.
          this.wildcardProtocols.delete(family);
        }
      }
      for (const protocol of this.protocols) {
        if (protocol.localCandidate) {
          protocol.localCandidate.generation = this.generation;
          protocol.localCandidate.ufrag = this.localUsername;
          // A wildcard socket's local candidate is one of its
          // server-reflexive candidates, re-advertised below.
          if (!this.isWildcardProtocol(protocol)) {
            this.appendLocalCandidate(protocol.localCandidate);
          }
          for (const reflexive of this.reflexiveBySocket.get(protocol) ?? []) {
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
      const defaultRoutes = Promise.race([
        getDefaultRouteAddresses(this.options.useIpv4, this.options.useIpv6, [
          ...this.stunServers.map(([host]) => host),
          ...this.turnServers.map(({ address: [host] }) => host),
        ]),
        this.closedSignal.then(() => [] as string[]),
      ]);

      const { primary, background } = this.getCandidatePromises(
        address,
        this.options.stunGatherTimeout,
        generation,
        defaultRoutes,
      );
      // close() ends the gathering at once: the continuations above close
      // whatever a server query still opens for a closed agent.
      await Promise.race([Promise.allSettled(primary), this.closedSignal]);

      // A later ICE restart (or close) owns the agent now: this gathering
      // neither completes that generation nor touches its state.
      if (!this.isGathering(generation)) return;
      const pending = background.filter(({ settled }) => !settled);
      if (pending.length === 0) {
        this.localCandidatesEnd = true;
      } else {
        // The other host sockets' server-reflexive candidates trickle in;
        // end-of-candidates follows the last of them.
        this.localCandidatesEndPromise = Promise.race([
          Promise.allSettled(pending.map(({ query }) => query)),
          this.closedSignal,
        ]).then(() => {
          if (!this.isGathering(generation)) return;
          this.localCandidatesEnd = true;
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

  private ensureProtocol(protocol: Protocol) {
    protocol.onRequestReceived.subscribe((msg, addr, data) => {
      if (msg.messageMethod !== methods.BINDING) {
        this.respondError(msg, addr, protocol, [400, "Bad Request"]);
        return;
      }

      // The MESSAGE-INTEGRITY / MESSAGE-INTEGRITY-SHA256 of an incoming check
      // is not verified here (parseMessage(data, localPassword) would do it):
      // rejecting unverifiable checks with 401 (RFC 8445 §7.3, RFC 8489
      // §9.1.3) changes established behavior and is tracked separately.
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
        !this.provisionalChecklist.allows(staged, protocol)
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
        .addIntegrity(
          Buffer.from(localPassword, "utf8"),
          responseIntegrityMode(msg),
        )
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
        this.provisionalChecklist.checkIncoming(
          provisional,
          msg,
          addr,
          protocol,
        );
        return;
      }

      if (this.checkList.length === 0 && !this.earlyChecksDone) {
        this.earlyChecks.push([msg, addr, protocol]);
      } else {
        this.checkIncoming(msg, addr, protocol);
      }
    });
    protocol.onDataReceived.subscribe((data, addr) => {
      try {
        // Update statistics for the nominated pair
        const activePair = this.nominated;
        if (activePair && activePair.protocol === protocol) {
          activePair.packetsReceived++;
          activePair.bytesReceived += data.length;
        }
        if (addr && this.failoverEnabled()) {
          this.failoverDataReceived(protocol, addr);
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

  /**
   * The gathering work of one generation.
   *
   * - `primary`: what gathering waits for. The host sockets, the TURN
   *   allocations and the server-reflexive queries of the representative
   *   sockets: the wildcard socket of each family and the host socket of
   *   the default-route address (every host socket when the family has
   *   neither).
   * - `background`: the server-reflexive queries of the other host sockets,
   *   complete once `primary` has settled. Their candidates trickle after
   *   gathering returns; end-of-candidates (`localCandidatesEnd`) waits for
   *   them. A network interface whose address cannot reach the STUN server
   *   so no longer delays gathering.
   */
  /**
   * The gathering work of one generation.
   *
   * - `primary`: what gathering waits for. The host sockets, the TURN
   *   allocations and the server-reflexive queries of the representative
   *   sockets: the wildcard socket of each family and the host socket of
   *   the default-route address (every host socket when the family has
   *   neither).
   * - `background`: the server-reflexive queries of the other host sockets,
   *   complete once `primary` has settled. Their candidates trickle after
   *   gathering returns; end-of-candidates (`localCandidatesEnd`) waits for
   *   them. A network interface whose address cannot reach the STUN server
   *   so no longer delays gathering.
   */
  private getCandidatePromises(
    hostAddresses: HostAddress[],
    timeout = 5,
    generation = this.generation,
    defaultRoutes: Promise<string[]> = Promise.resolve([]),
  ): {
    primary: Promise<unknown>[];
    background: { query: Promise<unknown>; settled: boolean }[];
  } {
    const primary: Promise<unknown>[] = [];
    // Filled while the primary work runs; complete once it has settled.
    const background: { query: Promise<unknown>; settled: boolean }[] = [];
    // Each continuation below runs after an await: a socket or allocation it
    // opened for a replaced generation (or a closed agent) is closed, and
    // nothing is added to the current one.
    const stale = () => !this.isGathering(generation);
    const { stunServers, turnServers } = this;
    const { interfaceAddresses } = this.options;
    const gatherIceLite = this.iceLite;
    const gatherRelayOnly = isRelayOnlyGathering(this.options);
    // Local preferences over the whole host list (the sockets an ICE restart
    // keeps included), so they stay distinct across generations.
    const localPreferenceOf = defaultRoutes.then((routes) => {
      const preferences = hostLocalPreferences(hostAddresses, routes);
      return new Map(
        hostAddresses.map(({ address }, i) => [
          normalizeIp(address),
          preferences[i],
        ]),
      );
    });

    // TCP host candidates are kept per address like the UDP ones, but on
    // their own: a restart that turned useTcp on gathers them for addresses
    // whose UDP sockets were kept.
    const tcpAddresses = hostAddresses
      .map(({ address }) => address)
      .filter(
        (address) =>
          !this.protocols.some(
            (protocol) =>
              protocol.localCandidate?.transport.toLowerCase() === "tcp" &&
              protocol.localIp === address,
          ),
      );
    const addresses = hostAddresses.filter(({ address }) => {
      // ice restartで同じアドレスが追加されるのを防ぐ
      // (localIp is the bound address, whose IPv6 notation may differ)
      if (
        this.protocols.find(
          (protocol) =>
            protocol.localIp !== undefined &&
            normalizeIp(protocol.localIp) === normalizeIp(address),
        )
      ) {
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
      : addresses.map(async ({ address, bind, bindAddress }) => {
          // # create transport
          const protocol = new StunProtocol();
          this.ensureProtocol(protocol);
          // An explicit interface address or an enumerated local address is
          // bound to, so packets of the socket leave from the advertised
          // address (a wildcard socket's source follows the routing table).
          const boundInterface =
            bind === HostAddressBind.explicit
              ? interfaceAddress(socketTypeOf(address), interfaceAddresses)
              : bind === HostAddressBind.enumerated
                ? bindAddress
                : undefined;
          try {
            await protocol.connectionMade(
              isIPv4(address),
              this.options.portRange,
              interfaceAddresses,
              bind === HostAddressBind.enumerated ? { bindAddress } : {},
            );
            const localPreference = (await localPreferenceOf).get(
              normalizeIp(address),
            );
            if (stale()) {
              await protocol.close();
              return;
            }

            // # add host candidate
            // A socket bound to an address advertises the bound address: the
            // peer sends its checks there and the socket's packets leave from
            // it. A wildcard socket advertises the gathered address (never
            // 0.0.0.0 / ::).
            const [boundHost, boundPort] = protocol.getExtraInfo();
            let candidateHost = address;
            if (boundInterface) {
              candidateHost = stripZoneId(boundHost);
              if (normalizeIp(candidateHost) !== normalizeIp(address)) {
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
              candidatePriority("host", {
                transport: "udp",
                localPreference,
              }),
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
              // No host candidate for this address: advertising it from
              // another (wildcard) socket would mislead the peer. Candidates
              // of the other addresses are gathered independently.
              log(
                "failed to bind UDP socket to host address",
                boundInterface,
                error,
              );
            } else {
              log("error protocol STUN", error);
            }
          }
        });

    if (!gatherRelayOnly) {
      primary.push(
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

      primary.push(...tcpCandidatePromises);
    }

    // A server-reflexive query of one socket to one STUN server, bounded by
    // the STUN gather timeout; an unanswered one yields nothing.
    const queryReflexive = async (protocol: StunProtocol, server: Address) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const candidate = await Promise.race([
        serverReflexiveCandidate(
          protocol,
          server,
          this.wildcardBaseOf(protocol),
        ).catch((error) => {
          log("query STUN server", server, error);
          return undefined;
        }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeout * 1000);
        }),
      ]);
      clearTimeout(timer);
      return candidate;
    };
    // RFC 8445 §5.1.3: a mapping equal to one the socket already advertised
    // (same base, same transport address) is redundant.
    const sameMapping = (a: Candidate, b: Candidate) =>
      a.host === b.host && a.port === b.port;

    if (!gatherIceLite && !gatherRelayOnly && stunServers.length > 0) {
      // # wildcard sockets
      // In the default mode (no interfaceAddresses) every family with a STUN
      // server gets one more UDP socket bound to the wildcard address. It
      // advertises no host candidate; the OS picks its route, so it maps
      // even when the only way out is an interface the host sockets do not
      // cover, and it receives whatever reaches its port (a DNAT to another
      // local address, an address added after gathering).
      const defaultMode =
        !interfaceAddresses?.udp4 && !interfaceAddresses?.udp6;
      const wildcardReady = new Map<4 | 6, Promise<boolean>>();
      for (const family of [4, 6] as const) {
        const enabled =
          family === 4 ? this.options.useIpv4 : this.options.useIpv6;
        if (
          !defaultMode ||
          !enabled ||
          this.reflexiveServersOf(family).length === 0
        ) {
          continue;
        }
        const kept = this.wildcardProtocols.get(family);
        if (kept && this.protocols.includes(kept)) {
          // Kept across an ICE restart: queried again with the reused sockets.
          wildcardReady.set(family, Promise.resolve(true));
          continue;
        }
        // One still opening for a replaced generation is not reused.
        if (kept) {
          this.wildcardProtocols.delete(family);
          void kept.close().catch(() => {});
        }
        const query = this.gatherWildcardReflexive(
          family,
          queryReflexive,
          sameMapping,
          stale,
        );
        wildcardReady.set(
          family,
          query.then(({ bound }) => bound),
        );
        primary.push(query);
      }

      // Sockets kept across an ICE restart query every STUN server again.
      // The mappings they already advertised are in the new generation from
      // the start; a different fresh mapping (the NAT rebound) is added to
      // it, and the fresh mappings replace the kept ones for the next restart.
      const reflexiveOfReused = (protocol: StunProtocol) =>
        (async () => {
          const previous = this.reflexiveBySocket.get(protocol) ?? [];
          const advertised = [...previous];
          const fresh: Candidate[] = [];
          await Promise.all(
            this.reflexiveServersOf(protocol).map(async (server) => {
              const candidate = await queryReflexive(protocol, server);
              if (!candidate || stale()) return;
              if (!fresh.some((known) => sameMapping(known, candidate))) {
                fresh.push(candidate);
              }
              if (advertised.some((known) => sameMapping(known, candidate))) {
                return;
              }
              advertised.push(candidate);
              this.appendLocalCandidate(candidate);
            }),
          );
          if (stale()) return;
          if (fresh.length > 0) this.reflexiveBySocket.set(protocol, fresh);
          return fresh.length > 0 ? fresh : previous;
        })().catch((error) => {
          log("query STUN server", error);
        });

      // Every new IPv4 host socket queries every STUN server in parallel.
      const reflexiveOfNew = (protocol: StunProtocol) =>
        (async () => {
          const advertised: Candidate[] = [];
          await Promise.all(
            stunServers.map(async (server) => {
              const candidate = await queryReflexive(protocol, server);
              if (!candidate || stale()) return;
              if (advertised.some((known) => sameMapping(known, candidate))) {
                return;
              }
              advertised.push(candidate);
              this.reflexiveBySocket.set(protocol, advertised);
              this.appendLocalCandidate(candidate);
            }),
          ).catch((error) => {
            log("query STUN server", error);
          });
          return advertised;
        })();

      // A kept wildcard socket is a representative: gathering waits for it.
      const reusedWildcards = [...this.wildcardProtocols.values()].filter(
        (protocol) => this.protocols.includes(protocol),
      );
      primary.push(...reusedWildcards.map(reflexiveOfReused));

      // The host sockets' queries start at once. The representative ones
      // (the default-route address; every socket when the family has neither
      // a wildcard socket nor a default-route socket) are waited for, the
      // others run in the background.
      type HostQuery = { protocol: StunProtocol; query: Promise<unknown> };
      const track = (protocol: StunProtocol, query: Promise<unknown>) => {
        const entry = { protocol, query, settled: false };
        void query.finally(() => {
          entry.settled = true;
        });
        return entry;
      };
      const reusedHosts: HostQuery[] = reusedStunProtocols
        .filter((protocol) => isIPv4(protocol.localCandidate!.host))
        .map((protocol) => track(protocol, reflexiveOfReused(protocol)));
      const newHosts = Promise.all(
        localStunPromises.map(async (protocolPromise) => {
          const protocol = await protocolPromise;
          if (
            !protocol?.localCandidate ||
            !isIPv4(protocol.localCandidate.host)
          ) {
            return;
          }
          return track(protocol, reflexiveOfNew(protocol));
        }),
      );
      primary.push(
        (async () => {
          const queries = [
            ...reusedHosts,
            ...(await newHosts).filter((entry) => entry !== undefined),
          ] as (HostQuery & { settled: boolean })[];
          const routes = (await defaultRoutes).map(normalizeIp);
          const defaultRouteQueries = queries.filter(({ protocol }) =>
            routes.includes(normalizeIp(protocol.localCandidate!.host)),
          );
          const representative =
            defaultRouteQueries.length > 0 || (await wildcardReady.get(4))
              ? defaultRouteQueries
              : queries;
          // Filled before this primary work settles: gatherCandidates()
          // reads it then.
          background.push(
            ...queries.filter((entry) => !representative.includes(entry)),
          );
          await Promise.allSettled(representative.map(({ query }) => query));
        })(),
      );
    }

    if (!gatherIceLite) {
      // Every TURN server gets its own allocation, made with its own
      // credential and transport; one that fails does not stop the others.
      // A TURN allocation has its own UDP socket, bound to the wildcard
      // address unless interfaceAddresses binds the family: the OS picks
      // its route as for the wildcard STUN socket.
      const turnCandidatePromises = turnServers.map((server) =>
        this.gatherRelayCandidate(server, gatherRelayOnly, stale).catch(
          (error) => {
            log("query TURN server", server.address, error);
          },
        ),
      );
      primary.push(...turnCandidatePromises);
    }

    return { primary, background };
  }

  /**
   * Open the wildcard socket of `family` and query the STUN servers from it.
   * Its first server-reflexive candidate becomes the socket's local
   * candidate: the socket joins the agent and pairs with the remote
   * candidates (its checks leave through the NAT mapping it advertised).
   * A socket that maps nothing is closed.
   */
  private async gatherWildcardReflexive(
    family: 4 | 6,
    queryReflexive: (
      protocol: StunProtocol,
      server: Address,
    ) => Promise<Candidate | undefined>,
    sameMapping: (a: Candidate, b: Candidate) => boolean,
    stale: () => boolean,
  ): Promise<{ bound: boolean }> {
    const protocol = new StunProtocol();
    try {
      // No interfaceAddresses / bindAddress: the wildcard address.
      await protocol.connectionMade(family === 4, this.options.portRange);
    } catch (error) {
      log("failed to bind the wildcard UDP socket", family, error);
      return { bound: false };
    }
    if (stale()) {
      await protocol.close();
      return { bound: true };
    }
    this.wildcardProtocols.set(family, protocol);

    const advertised: Candidate[] = [];
    await Promise.all(
      this.reflexiveServersOf(family).map(async (server) => {
        const candidate = await queryReflexive(protocol, server);
        if (!candidate || stale() || !this.isWildcardProtocol(protocol)) return;
        if (advertised.some((known) => sameMapping(known, candidate))) {
          return;
        }
        advertised.push(candidate);
        this.reflexiveBySocket.set(protocol, advertised);
        if (!protocol.localCandidate) {
          protocol.localCandidate = candidate;
          protocol.localIp = family === 4 ? "0.0.0.0" : "::";
          this.ensureProtocol(protocol);
          this.protocols.push(protocol);
          this.pairLocalProtocol(protocol);
        }
        this.appendLocalCandidate(candidate);
      }),
    );
    if (!protocol.localCandidate) {
      if (this.wildcardProtocols.get(family) === protocol) {
        this.wildcardProtocols.delete(family);
      }
      await protocol.close();
    }
    return { bound: true };
  }

  /** Whether `protocol` is a wildcard socket (advertises no host candidate). */
  private isWildcardProtocol(protocol: Protocol) {
    for (const wildcard of this.wildcardProtocols.values()) {
      if (wildcard === protocol) return true;
    }
    return false;
  }

  /**
   * Whether the wildcard socket should check `remoteCandidate`: only a path
   * no host socket covers. When the OS routes to the remote address from an
   * address a UDP host socket is bound to, that socket checks the same path
   * (through a NAT as its own server-reflexive address), while the wildcard
   * socket's packets would leave from an address it does not advertise and
   * make the peer learn a peer-reflexive candidate. Without a route the
   * socket cannot reach the address either.
   */
  private async wildcardPathUncovered(remoteCandidate: Candidate) {
    const source = await getRouteSourceAddress(remoteCandidate.host);
    if (!source) return false;
    return !this.protocols.some(
      (protocol) =>
        protocol instanceof StunProtocol &&
        protocol.localCandidate?.type === "host" &&
        protocol.localCandidate.transport === "udp" &&
        normalizeIp(protocol.localCandidate.host) === normalizeIp(source),
    );
  }

  /** The base of a wildcard socket's server-reflexive candidates. */
  private wildcardBaseOf(protocol: StunProtocol) {
    if (!this.isWildcardProtocol(protocol)) return undefined;
    const [host, port] = protocol.getExtraInfo();
    return {
      host: isIPv6(stripZoneId(host)) ? "::" : "0.0.0.0",
      port,
      transport: "udp",
      component: 1,
    };
  }

  /**
   * The STUN servers a socket (or the wildcard socket of a family) queries:
   * every server for IPv4 (as the IPv4 host sockets always did), only the
   * IPv6 literal servers for the IPv6 wildcard socket.
   */
  private reflexiveServersOf(target: StunProtocol | 4 | 6) {
    const family =
      typeof target === "number"
        ? target
        : this.isWildcardProtocol(target) &&
            isIPv6(stripZoneId(target.getExtraInfo()[0]))
          ? 6
          : 4;
    return family === 4
      ? this.stunServers
      : this.stunServers.filter(([host]) => isIPv6(host));
  }

  /**
   * Allocate on one TURN server and add its relay candidate. A UDP
   * allocation that fails falls back to TCP on the same server. An
   * allocation that completes for a replaced generation (or a closed agent)
   * is released.
   */
  private async gatherRelayCandidate(
    server: Required<TurnServerOptions>,
    relayOnly: boolean,
    stale: () => boolean,
  ) {
    const { address, username, password, transport } = server;
    const protocol = await createStunOverTurnClient(
      { address, username, password },
      {
        portRange: this.options.portRange,
        interfaceAddresses: this.options.interfaceAddresses,
        transport,
        tlsOptions: this.options.turnTlsOptions,
        connectTimeoutMs: (this.options.turnConnectTimeout ?? 8) * 1000,
        udpFamily: this.options.turnUdpFamily,
        signal: this.closing.signal,
      },
    ).catch(async (e) => {
      // close() cancelled the allocation: no TCP fallback.
      if (transport === "udp" && !this.closing.signal.aborted) {
        return await createStunOverTurnClient(
          { address, username, password },
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
    protocol.configuredTransport = transport;
    this.ensureProtocol(protocol);
    this.protocols.push(protocol);

    const candidateAddress = protocol.turn.relayedAddress;
    // The related address of a relay candidate is the address the TURN
    // server saw the agent at. A relay-only policy hides the agent's
    // addresses from the peer, so it advertises the unspecified address
    // and port 9 instead (RFC 8839 §5.1), in SDP and trickle alike.
    const relatedAddress: Address = relayOnly
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
      // A selection that may still be replaced: the checks of the pairs that
      // outrank it go on in `SelectionReplacement.checkOutrankingPairs`.
      if (this.nominated && this.iceControlling && this.replacesSelection()) {
        break;
      }
      if (!this.schedulingChecks()) break;
      await timers.setTimeout(20);
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
      res = await this.checkListState.get();
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

  /** Start RFC 7675 consent freshness for the selected pair. */
  private queryConsent() {
    this.consent.start();
  }

  async close() {
    // """
    // Close the connection.
    // """

    this.closed = true;
    this.setState("closed");
    this.signalClosed();
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
    const pendingWildcards = [...this.wildcardProtocols.values()].filter(
      (protocol) => !this.protocols.includes(protocol),
    );
    this.wildcardProtocols.clear();
    for (const protocol of [...this.protocols, ...pendingWildcards]) {
      if (protocol.close) {
        await protocol.close();
      }
    }

    this.protocols = [];
    this.localCandidates = [];
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
    const roleChanged = this._iceControlling !== iceControlling;
    if (roleChanged) {
      this.invalidateNominations();
      this.selection.clearRetries();
      // Checks in flight carry the old role: the backups' stop (monitoring
      // starts again under the new role below), and so do the selected
      // pair's consent requests (not counted as unanswered; the next one
      // carries the new role).
      this.failover.halt();
      this.consent.cancelRequests();
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
    if (roleChanged) this.failover.refresh();
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
        // Failover: the selection moves off a pair that stopped answering,
        // or a failover nomination sent while it did not answer succeeded.
        const failingOver =
          !!previous &&
          (this.selectionDown() || this.failoverNomination === pair);
        if (this.failoverNomination === pair) {
          this.failoverNomination = undefined;
        }
        log(
          failingOver
            ? "selected pair failed over"
            : previous
              ? "selected pair replaced"
              : "nominated",
          pair.toJSON(),
          { previous: previous?.toJSON() },
        );
        this.nominated = pair;
        this.liteNominating = false;
        this.nomination.stop();
        if (failingOver) {
          // The old pair is a backup of its socket now: the selection moves
          // back only once that socket answers again (FailoverMonitor.allows),
          // with a new nomination.
          previous.nominated = false;
          this.failover.demote(previous);
        }
        // RFC 7675 section 5.1: the successful connectivity check that
        // selected the pair is its initial consent, so data may flow at once
        // instead of waiting for the consent lifecycle to start.
        this.consent.fresh = true;
        this.clearConsentExpiredGrace();
        this.pruneTcpConnections(pair);
        this.failover.selected(pair);

        // After resetNominatedPair / renomination while already connected,
        // restart consent freshness on the new selected pair.
        if (
          !this.iceLite &&
          (this.state === "connected" ||
            this.state === "completed" ||
            this.state === "disconnected")
        ) {
          this.queryConsent();
        }

        // 8.1.2.  Updating States

        // The agent MUST remove all Waiting and Frozen pairs in the check
        // list and triggered check queue for the same component as the
        // nominated pairs for that media stream. A controlling agent that
        // may replace the selection keeps the pairs that outrank it, and
        // failover keeps the backup of each other socket.
        const keepsChecking = this.iceControlling && this.replacesSelection();
        const backups = this.failover.keeps();
        for (const p of this.checkList) {
          if (
            p.component === pair.component &&
            (
              [
                CandidatePairState.WAITING,
                CandidatePairState.FROZEN,
              ] as CandidatePairState[]
            ).includes(p.state) &&
            !(
              keepsChecking &&
              this.replacesWith(p) &&
              this.outranks(p, pair)
            ) &&
            !backups.has(p)
          ) {
            p.updateState(CandidatePairState.FAILED);
            if (this.failoverEnabled()) this.failover.prunedWithoutCheck(p);
          }
        }
        this.updateLinkState();
      }

      // Once there is at least one nominated pair in the valid list for
      // every component of at least one media stream and the state of the
      // check list is Running:
      if (this.nominated) {
        this.failover.refresh();
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
    // A backup (or a failover target) that failed is replaced.
    if (this.nominated) this.failover.refresh();

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

      // Semi-aggressive nomination: USE-CANDIDATE while nothing is selected
      // and for a pair that outranks the selected one. Regular nomination
      // (RegularNomination) and renomination (`SelectionReplacement.evaluate`) nominate
      // with a separate check; an ordinary check carries nothing.
      const nominate =
        this.usesSemiAggressiveNomination() &&
        this.replacesWith(pair) &&
        (!this.nominated ||
          (this.outranks(pair, this.nominated) && this.failoverAllows(pair)));
      const request = this.buildRequest({
        nominate,
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
        this.failover.responded(pair);

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
          this.checkCancelled(pair, remoteGeneration);
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
    // A pair that may replace the selection is checked after it too.
    const selected = this.nominated;
    if (
      selected &&
      this.iceControlling &&
      this.replacesSelection() &&
      this.replacesWith(pair) &&
      this.outranks(pair, selected) &&
      this.failoverAllows(pair)
    ) {
      void this.selection.checkOutrankingPairs();
    }
    // A pair of another socket may become its backup.
    if (selected) this.failover.refresh();
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
    this.failover.received(pair);
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
    if (!routeChecked && this.isWildcardProtocol(protocol)) {
      void this.wildcardPathUncovered(remoteCandidate).then((uncovered) => {
        if (
          uncovered &&
          (!this.nominated ||
            (this.iceControlling && this.replacesSelection())) &&
          !this.checkListDone &&
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
    // Failover: a pair of another socket, or of the selected pair's socket
    // to another remote address, may become a backup.
    const failover = this.failoverEnabled();
    return (pair) =>
      this.replacesWith(pair) &&
      (this.outranks(pair, selected) ||
        (failover &&
          (pair.protocol !== selected.protocol ||
            pair.remoteAddr[0] !== selected.remoteAddr[0] ||
            pair.remoteAddr[1] !== selected.remoteAddr[1])));
  }

  /**
   * Failover of the selected pair without an ICE restart (libwebrtc
   * compatible) applies to the agent's mode: both agents are full ICE and the
   * agent uses semi-aggressive nomination or renomination (the modes in which
   * a controlling agent may replace the selection, `replacesSelection`; a
   * controlled agent follows the peer's nominations). Regular nomination
   * (RFC 8445 §8.1.1 allows no other pair without an ICE restart) and ICE-lite
   * keep the selection until consent expires.
   */
  private failoverScope() {
    if (this.iceLite || this.remoteIsLite || this.state === "closed") {
      return false;
    }
    if (this.options.renomination && this.remoteRenomination) return true;
    return this.options.nomination !== "regular";
  }

  /** {@link failoverScope}, and the selected pair is not ICE-TCP (its closed connection fails the agent). */
  private failoverEnabled() {
    const transport = this.nominated?.protocol?.localCandidate?.transport;
    return (
      transport !== undefined &&
      transport.toLowerCase() !== "tcp" &&
      this.failoverScope()
    );
  }

  /** Failover: the selected pair stopped answering (unwritable) or its consent expired. */
  private selectionDown() {
    const selected = this.nominated;
    return (
      !!selected &&
      this.failoverEnabled() &&
      (!this.consent.fresh || this.failover.knownUnwritable(selected))
    );
  }

  /** Whether `pair` may be nominated to move the selection up (see `FailoverMonitor.allows`). */
  private failoverAllows(pair: CandidatePair) {
    return !this.failoverEnabled() || this.failover.allows(pair);
  }

  private failoverHost(): FailoverHost {
    return {
      enabled: () => this.failoverEnabled(),
      selected: () => this.nominated,
      pairs: () => this.checkList,
      eligible: (pair) => this.replacesWith(pair),
      iceControlling: () => this.iceControlling,
      ping: (pair, signal) => this.pingBackup(pair, signal),
      validated: (pair) => {
        pair.updateState(CandidatePairState.SUCCEEDED);
        if (pair.remoteNominated && !this.iceControlling) pair.nominated = true;
        this.checkComplete(pair);
      },
      dropped: (pair) => {
        if (pair !== this.nominated) {
          pair.updateState(CandidatePairState.FAILED);
        }
      },
      changed: () => this.onLinkChanged(),
      recovered: () => this.selection.evaluate(),
    };
  }

  /** The writability of a monitored pair may have changed. */
  private onLinkChanged() {
    this.evaluateFailover();
    this.updateLinkState();
  }

  /**
   * Failover (controlling): the selected pair stopped answering, so nominate
   * the best writable backup (`FailoverMonitor.target`), with USE-CANDIDATE
   * (semi-aggressive) or the next NOMINATION value (renomination). Its
   * success moves the selection (`replacesSelectedPair`). A controlled agent
   * only follows the peer's nominations.
   */
  private evaluateFailover() {
    if (
      !this.iceControlling ||
      !this.replacesSelection() ||
      this.selection.nominating ||
      this.state === "closed" ||
      this.state === "failed" ||
      !this.selectionDown()
    ) {
      return;
    }
    const target = this.failover.target();
    if (!target) return;
    log("failover", target.toJSON(), { selected: this.nominated?.toJSON() });
    this.failoverNomination = target;
    this.selection.nominate(target);
  }

  /**
   * Failover: the agent's state from the selected pair and the backups.
   * `disconnected` while the selected pair is unwritable and no backup is
   * writable; back to the state it replaced only once the selected pair is
   * writable again (it recovered, or the selection moved to a backup); a
   * backup that answers before the selection moved to it keeps the agent
   * `disconnected`. `failed` once the selected pair's consent expired with no
   * writable backup left.
   */
  private updateLinkState() {
    if (!this.failoverEnabled()) return;
    const state = this.state;
    if (
      state !== "connected" &&
      state !== "completed" &&
      state !== "disconnected"
    ) {
      return;
    }
    const selected = this.nominated!;
    const selectedUp =
      this.consent.fresh && !this.failover.knownUnwritable(selected);
    if (selectedUp) {
      // The selected pair answers again, or the selection moved to a
      // backup that answers (a replacement is selected with a fresh
      // response).
      if (state === "disconnected") {
        this.setState(this.stateBeforeDisconnect ?? "connected");
      }
      return;
    }
    if (!this.consent.fresh) {
      // Consent expired: nothing can be sent. Disconnected while a writable
      // backup may still take over within the grace period, else failed.
      if (
        this.consentExpiredGrace !== undefined &&
        this.failover.hasWritableBackup()
      ) {
        if (state !== "disconnected") {
          this.stateBeforeDisconnect = state;
          this.setState("disconnected");
        }
        return;
      }
      log("consent expired without a writable backup");
      this.failConsentExpired();
      return;
    }
    // A writable backup the selection may still move to (the controlling
    // agent's nomination, the controlled agent's peer): not disconnected
    // yet, but not recovered either until the selection moved.
    if (this.failover.hasWritableBackup()) return;
    if (state !== "disconnected") {
      this.stateBeforeDisconnect = state;
      this.setState("disconnected");
    }
  }

  /** See `consentExpiredGrace`. */
  private startConsentExpiredGrace() {
    if (this.consentExpiredGrace !== undefined) return;
    this.consentExpiredGrace = setTimeout(() => {
      this.consentExpiredGrace = undefined;
      if (this.consent.fresh) return;
      const state = this.state;
      if (state === "closed" || state === "failed") return;
      log("consent expired and the selection did not move to a backup");
      this.failConsentExpired();
    }, FAILOVER_CONSENT_EXPIRED_GRACE);
  }

  private clearConsentExpiredGrace() {
    if (this.consentExpiredGrace === undefined) return;
    clearTimeout(this.consentExpiredGrace);
    this.consentExpiredGrace = undefined;
  }

  /** The selected pair's consent expired and no backup took over: the agent fails (an ICE restart recovers). */
  private failConsentExpired() {
    this.clearConsentExpiredGrace();
    this.consent.stop();
    this.failover.reset();
    this.setState("failed");
  }

  /** Failover: application data arrived on `protocol` from `addr`. */
  private failoverDataReceived(protocol: Protocol, addr: Address) {
    const sameAddress = (pair: CandidatePair) =>
      pair.protocol === protocol &&
      pair.remoteAddr[0] === addr[0] &&
      pair.remoteAddr[1] === addr[1];
    const selected = this.nominated;
    const pair =
      selected && sameAddress(selected)
        ? selected
        : this.failover.backupPairs.find(sameAddress);
    if (pair) this.failover.received(pair);
  }

  /**
   * Failover: one check of a backup pair, as libwebrtc pings its
   * connections: no nomination (USE-CANDIDATE / NOMINATION only when the
   * selection moves to it), a single transmission with the consent response
   * timeout. Resolves true when it was answered from the pair's address.
   */
  private async pingBackup(pair: CandidatePair, signal: AbortSignal) {
    const { iceControlling } = this;
    const request = this.buildRequest({
      nominate: false,
      localUsername: pair.localCandidate.ufrag ?? this.localUsername,
      remoteUsername: this.remoteUsername,
      iceControlling,
      localCandidate: pair.localCandidate,
    });
    pair.requestsSent++;
    const startedAt = performance.now();
    try {
      const [, addr] = await pair.protocol.request(
        request,
        pair.remoteAddr,
        Buffer.from(this.remotePassword, "utf8"),
        {
          retransmissions: 0,
          responseTimeout:
            pair.rtt === undefined
              ? BACKUP_UNKNOWN_RTT_RESPONSE_TIMEOUT
              : consentResponseTimeoutMs(pair.rtt),
          signal: AbortSignal.any([this.remoteChecks.signal, signal]),
          integrityAlgorithm: this.options.messageIntegrity,
        },
      );
      if (
        signal.aborted ||
        addr[0] !== pair.remoteAddr[0] ||
        addr[1] !== pair.remoteAddr[1]
      ) {
        return false;
      }
      pair.responsesReceived++;
      const rtt = (performance.now() - startedAt) / 1000;
      pair.rtt = rtt;
      pair.totalRoundTripTime += rtt;
      pair.roundTripTimeMeasurements++;
      return true;
    } catch (error) {
      // 487: repair the role conflict as a check does (RFC 8445 §7.2.5.1).
      if (
        !signal.aborted &&
        isRoleConflict(error) &&
        this.iceControlling === iceControlling
      ) {
        this.switchRole(!iceControlling);
      }
      return false;
    }
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
      // Failover (a controlled agent): the new socket may keep a backup.
      const selected = this.nominated;
      if (!selected || !this.failoverEnabled()) return;
      for (const remoteCandidate of this.remoteCandidates) {
        this.tryPair(
          protocol,
          remoteCandidate,
          (pair) =>
            this.replacesWith(pair) && pair.protocol !== selected.protocol,
        );
      }
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

const socketTypeOf = (address: string) => (isIPv4(address) ? "udp4" : "udp6");
const stripZoneId = (address: string) => address.split("%")[0];
