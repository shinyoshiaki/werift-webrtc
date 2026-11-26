import { Candidate, remoteTcpTypeForIncoming } from "./candidate";
import type { MdnsLookup } from "./dns/lookup";
import { type TransactionError, TransactionTimeout } from "./exceptions";
import { randomString } from "./helper";
import {
  CandidatePair,
  CandidatePairState,
  type IceOptions,
  isCandidateAllowedByGatherOptions,
  normalizeIceServerOptions,
  sortCandidatePairs,
  validateRemoteCandidate,
} from "./iceBase";
import { type Address, debug } from "./imports/common";
import {
  decodeTxUsername,
  isRoleConflict,
  receivedNomination,
} from "./internal/checkMessages";
import {
  type NominationHost,
  type NominationOutcome,
  RegularNomination,
} from "./nomination/regularNomination";
import type { Message } from "./stun/message";
import { StunOverTurnProtocol } from "./turn/protocol";
import type { Protocol } from "./types/model";

const log = debug("werift-ice : packages/ice/src/provisional.ts : log");

/**
 * The checklist of an ICE restart negotiated with a pranswer: checked beside
 * the selected pair of the live checklist, which keeps carrying data until
 * the final answer commits (or discards) the restart.
 */
export type ProvisionalGeneration = {
  localUsername: string;
  localPassword: string;
  /**
   * Checks received for the staged ufrag (at most `MAX_CARRIED_CHECKS`),
   * replayed as early checks if an answer commits this generation
   * (`Connection.commitLocalCredentials`).
   */
  receivedChecks: [Message, Address, Protocol][];
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

/** What the agent supplies to its `ProvisionalChecklist`. */
export type ProvisionalHost = {
  closed: () => boolean;
  iceLite: () => boolean;
  iceControlling: () => boolean;
  remoteIsLite: () => boolean;
  localCandidatesEnd: () => boolean;
  options: () => IceOptions;
  /** The agent's sockets and TURN allocations. */
  protocols: () => readonly Protocol[];
  /** The agent's mDNS resolver (created on first use). */
  mdnsLookup: () => MdnsLookup;
  /** A pair the agent never checks itself (forceTurn). */
  isUncheckedPair: (pair: CandidatePair) => boolean;
  /** A wildcard socket (`CandidateGatherer.isWildcardProtocol`). */
  isWildcardProtocol: (protocol: Protocol) => boolean;
  /**
   * The wildcard socket should check `remoteCandidate`: no host socket
   * covers its path (`CandidateGatherer.wildcardPathUncovered`).
   */
  wildcardPathUncovered: (remoteCandidate: Candidate) => Promise<boolean>;
  /** Full ICE on both sides and this agent controlling. */
  nominatesFullPeer: () => boolean;
  usesRegularNomination: () => boolean;
  /** A pair semi-aggressive nomination and renomination may select. */
  replacesWith: (pair: CandidatePair) => boolean;
  /** The pairs `RegularNomination` nominates from. */
  regularNominationPairs: (
    pairs: readonly CandidatePair[],
  ) => readonly CandidatePair[];
  bestValidPair: (pairs: CandidatePair[]) => CandidatePair | undefined;
  outranks: (pair: CandidatePair, other: CandidatePair) => boolean;
  nominationDelayMs: () => number;
  buildRequest: (params: {
    nominate: boolean;
    localUsername: string;
    remoteUsername: string;
    iceControlling: boolean;
    localCandidate: Candidate;
  }) => Message;
  switchRole: (iceControlling: boolean) => void;
};

/**
 * The provisional generation of an ICE restart (`ProvisionalGeneration`):
 * staged by `stage()` with the local credentials of the restart offer,
 * given the pranswer's credentials and candidates, checked (`start()`) and
 * nominated with the same rules as the live checklist, and dropped by
 * `end()` when the final answer commits or discards the restart. It never
 * touches the live checklist.
 */
export class ProvisionalChecklist {
  /** The staged generation, if any. */
  generation?: ProvisionalGeneration;
  private readonly host: ProvisionalHost;

  constructor(host: ProvisionalHost) {
    this.host = host;
  }

  /**
   * Drop the provisional generation and stop the checks still in flight for
   * it (their retransmissions would outlive it).
   */
  end() {
    if (this.generation) {
      this.generation.checks.abort();
      this.generation.nomination.reset();
    }
    this.generation = undefined;
  }

  /** Stage a provisional generation for the local credentials of an ICE restart offer. */
  stage(
    usernameFragment: string,
    password: string,
    gatherOptions?: Partial<IceOptions>,
  ) {
    this.end();
    const generation: ProvisionalGeneration = {
      localUsername: usernameFragment,
      localPassword: password,
      gatherOptions,
      receivedChecks: [],
      remoteCandidates: [],
      remoteCandidatesEnd: false,
      remoteCandidatesEndRequested: false,
      resolutions: new Set(),
      revision: 0,
      pairs: [],
      nomination: new RegularNomination(this.nominationHost(() => generation)),
      started: false,
      checks: new AbortController(),
    };
    this.generation = generation;
  }

  /** Remote credentials of the provisional generation (pranswer). */
  setRemoteParams({
    usernameFragment,
    password,
  }: {
    usernameFragment: string;
    password: string;
  }) {
    const generation = this.generation;
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

  /** A remote candidate (or end-of-candidates) of the pranswer. */
  async addRemoteCandidate(remoteCandidate: Candidate | undefined) {
    const generation = this.generation;
    if (!generation || this.host.closed()) return;
    const revision = generation.revision;
    const current = () =>
      !this.host.closed() &&
      this.generation === generation &&
      generation.revision === revision;
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
        const resolution = this.host.mdnsLookup().lookup(remoteCandidate.host);
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
    for (const protocol of this.host.protocols()) {
      this.tryPair(generation, protocol, remoteCandidate);
    }
  }

  /** Start checks for the provisional generation; the selected pair is kept. */
  start() {
    const generation = this.generation;
    if (!generation || generation.started) return;
    generation.started = true;
    for (const remoteCandidate of generation.remoteCandidates) {
      for (const protocol of this.host.protocols()) {
        this.tryPair(generation, protocol, remoteCandidate);
      }
    }
    for (const pair of generation.pairs) {
      if (!this.host.isUncheckedPair(pair)) {
        void this.check(generation, pair);
      }
    }
  }

  get nominated() {
    return this.generation?.nominated;
  }

  /**
   * @param routeChecked a wildcard socket's pair whose path no host socket
   *   covers (checked by `wildcardPathUncovered`, as the live checklist does).
   */
  private tryPair(
    generation: ProvisionalGeneration,
    protocol: Protocol,
    remoteCandidate: Candidate,
    routeChecked = false,
  ) {
    if (!routeChecked && this.host.isWildcardProtocol(protocol)) {
      void this.host
        .wildcardPathUncovered(remoteCandidate)
        .then((uncovered) => {
          if (uncovered && this.generation === generation) {
            this.tryPair(generation, protocol, remoteCandidate, true);
          }
        });
      return;
    }
    if (
      !protocol.localCandidate?.canPairWith(remoteCandidate) ||
      !this.allows(generation, protocol) ||
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
      this.host.iceControlling(),
    );
    // The provisional checklist admits the same pairs as the live one.
    const { filterCandidatePair } = this.host.options();
    if (filterCandidatePair && !filterCandidatePair(pair)) {
      return;
    }
    pair.updateState(CandidatePairState.WAITING);
    this.addPair(generation, pair);
    // As the live schedule does, forceTurn leaves host pairs unchecked.
    if (generation.started && !this.host.isUncheckedPair(pair)) {
      void this.check(generation, pair);
    }
  }

  private async check(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
    retry = true,
  ): Promise<void> {
    const revision = generation.revision;
    // A check belongs to one checklist: a replacement pranswer (new revision)
    // or a replaced generation makes its outcome meaningless.
    const belongs = () =>
      this.generation === generation &&
      generation.revision === revision &&
      generation.pairs.includes(pair);
    if (
      // An ICE-lite agent only answers checks (RFC 8445 §2.5), in the
      // provisional generation as in the live one.
      this.host.iceLite() ||
      !belongs() ||
      !generation.started ||
      !generation.remoteUsername ||
      !generation.remotePassword ||
      (
        [
          CandidatePairState.IN_PROGRESS,
          CandidatePairState.SUCCEEDED,
        ] as CandidatePairState[]
      ).includes(pair.state)
    ) {
      return;
    }
    pair.updateState(CandidatePairState.IN_PROGRESS);
    // Regular nomination: a check never carries USE-CANDIDATE; the
    // nomination is a separate check (`generation.nomination`). Otherwise
    // (semi-aggressive nomination, renomination) checks carry USE-CANDIDATE
    // until a pair is selected: the provisional checklist only selects once,
    // and the final answer checks the live one from scratch.
    const nominate =
      this.host.nominatesFullPeer() &&
      !this.host.usesRegularNomination() &&
      !generation.nominated &&
      this.host.replacesWith(pair);
    const request = this.host.buildRequest({
      nominate,
      localUsername: generation.localUsername,
      remoteUsername: generation.remoteUsername,
      iceControlling: this.host.iceControlling(),
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
          integrityAlgorithm: this.host.options().messageIntegrity,
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
        this.host.switchRole(request.attributesKeys.includes("ICE-CONTROLLED"));
        pair.updateState(CandidatePairState.WAITING);
        return this.check(generation, pair, false);
      }
      generation.nomination.evaluate();
      return;
    }
    // Only a controlled agent takes the peer's nomination (see checkStart).
    if (pair.remoteNominated && !this.host.iceControlling())
      pair.nominated = true;
    else if (nominate && this.host.iceControlling()) pair.nominated = true;
    pair.updateState(CandidatePairState.SUCCEEDED);
    if (
      !pair.nominated &&
      this.host.iceControlling() &&
      this.host.remoteIsLite() &&
      !generation.nominated &&
      !generation.liteNominating
    ) {
      // Toward an ICE-lite peer, as the live checklist does: nominate the
      // first pair that succeeded with a check that carries USE-CANDIDATE.
      generation.liteNominating = true;
      const result = await this.nominate(
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
  private addPair(generation: ProvisionalGeneration, pair: CandidatePair) {
    const best = this.host.bestValidPair(generation.pairs);
    generation.pairs.push(pair);
    generation.nomination.pairAdded(pair, best);
  }

  /**
   * The provisional checklist's side of regular nomination: the same rules
   * as the live checklist (`liveNominationHost`), on its own pairs,
   * credentials and end-of-candidates.
   */
  private nominationHost(
    generationOf: () => ProvisionalGeneration,
  ): NominationHost {
    const current = () => this.generation === generationOf();
    return {
      active: () =>
        current() &&
        this.host.nominatesFullPeer() &&
        generationOf().started &&
        !generationOf().nominated,
      checking: () => generationOf().started,
      pairs: () => {
        const pairs = [
          ...this.host.regularNominationPairs(generationOf().pairs),
        ];
        sortCandidatePairs(pairs, this.host.iceControlling());
        return pairs;
      },
      remoteCandidatesEnd: () => generationOf().remoteCandidatesEnd,
      localCandidatesEnd: () => this.host.localCandidatesEnd(),
      delayMs: () => this.host.nominationDelayMs(),
      unchecked: (pair) => this.host.isUncheckedPair(pair),
      outranks: (pair, other) => this.host.outranks(pair, other),
      preferred: () => undefined,
      owns: (pair) => current() && generationOf().pairs.includes(pair),
      send: (pair, signal) =>
        this.nominate(
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
      roleConflict: () => this.host.switchRole(false),
      abandoned: (pair) => pair?.updateState(CandidatePairState.FAILED),
    };
  }

  /**
   * Send a USE-CANDIDATE check for a provisional `pair` (see
   * `NominationOutcome`). `signal` stops it: the checklist's checks
   * (`end()`, a replacement pranswer) and, for regular nomination,
   * the attempt.
   */
  async nominate(
    generation: ProvisionalGeneration,
    pair: CandidatePair,
    signal: AbortSignal,
  ): Promise<NominationOutcome> {
    const request = this.host.buildRequest({
      nominate: true,
      localUsername: generation.localUsername,
      remoteUsername: generation.remoteUsername!,
      iceControlling: this.host.iceControlling(),
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
          // end() / a replacement pranswer stops it with the checks.
          signal: AbortSignal.any([signal, generation.checks.signal]),
          integrityAlgorithm: this.host.options().messageIntegrity,
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
  checkIncoming(
    generation: ProvisionalGeneration,
    message: Message,
    addr: Address,
    protocol: Protocol,
  ) {
    // A socket the staged generation drops at the commit takes no pair.
    if (!this.allows(generation, protocol)) return;
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
    // Kept for the commit: if this generation becomes live, connect() learns
    // the sender from it as from an early check.
    rememberStagedCheck(generation.receivedChecks, message, addr, protocol);
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
      pair = new CandidatePair(
        protocol,
        remoteCandidate,
        this.host.iceControlling(),
      );
      pair.updateState(CandidatePairState.WAITING);
      this.addPair(generation, pair);
    }
    pair.noteIncomingRequest(message.transactionIdHex);
    pair.requestsReceived++;
    pair.responsesSent++;

    if (receivedNomination(message) > 0 && !this.host.iceControlling()) {
      pair.remoteNominated = true;
      if (this.host.iceLite() || pair.state === CandidatePairState.SUCCEEDED) {
        pair.nominated = true;
        pair.updateState(CandidatePairState.SUCCEEDED);
        generation.nominated ??= pair;
      }
    }
    if (
      !this.host.iceLite() &&
      (
        [
          CandidatePairState.WAITING,
          CandidatePairState.FAILED,
        ] as CandidatePairState[]
      ).includes(pair.state)
    ) {
      void this.check(generation, pair);
    }
  }

  /**
   * Whether the provisional generation may use `protocol`: the staged
   * generation drops the sockets its gather options exclude at the commit,
   * so its checks never use them. A kept TURN allocation serves it only when
   * the generation still uses that TURN server, credential and transport (any of its
   * TURN servers): one whose server was removed or replaced (a credential
   * rotation) is not part of it.
   */
  allows(generation: ProvisionalGeneration, protocol: Protocol) {
    const options = generation.gatherOptions ?? this.host.options();
    if (
      !protocol.localCandidate ||
      !isCandidateAllowedByGatherOptions(protocol.localCandidate, options)
    ) {
      return false;
    }
    if (protocol instanceof StunOverTurnProtocol) {
      const { configuredServer, username, password } = protocol.turn;
      return normalizeIceServerOptions(options).turnServers.some(
        (server) =>
          configuredServer[0] === server.address[0] &&
          configuredServer[1] === server.address[1] &&
          username === server.username &&
          password === server.password &&
          protocol.configuredTransport === server.transport,
      );
    }
    return true;
  }
}

/** Upper bound of the checks a staged generation keeps for its commit. */
export const MAX_CARRIED_CHECKS = 32;

const senderOfCheck = (message: Message) => {
  const username = message.getAttributeValue("USERNAME");
  return typeof username === "string"
    ? decodeTxUsername(username).localUsername
    : "";
};

/**
 * Keep a check for the commit without letting it be crowded out. The sender's
 * ufrag is not always known yet (no pranswer), so the list cannot filter by
 * it: a repeat from the same sender / address / socket replaces the earlier
 * one (unless that one nominated: USE-CANDIDATE / NOMINATION is kept), and a
 * full list drops the oldest check of the sender holding the most, so a flood
 * from one (wrong) ufrag cannot evict the first check of another.
 */
const rememberStagedCheck = (
  checks: [Message, Address, Protocol][],
  message: Message,
  addr: Address,
  protocol: Protocol,
) => {
  const sender = senderOfCheck(message);
  const same = checks.findIndex(
    ([m, a, p]) =>
      p === protocol &&
      a[0] === addr[0] &&
      a[1] === addr[1] &&
      senderOfCheck(m) === sender,
  );
  if (same >= 0) {
    // A later plain check must not erase the nomination an earlier one made.
    if (receivedNomination(checks[same][0]) > 0) return;
    checks.splice(same, 1);
  } else if (checks.length >= MAX_CARRIED_CHECKS) {
    const counts = new Map<string, number>();
    for (const [m] of checks) {
      const key = senderOfCheck(m);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let victim = "";
    let most = 0;
    for (const [key, count] of counts) {
      if (count > most) {
        victim = key;
        most = count;
      }
    }
    checks.splice(
      checks.findIndex(([m]) => senderOfCheck(m) === victim),
      1,
    );
  }
  checks.push([message, addr, protocol]);
};
