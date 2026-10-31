import { randomBytes, randomUUID } from "crypto";
import {
  Candidate,
  Connection,
  type IceConnection,
  type IceOptions,
} from "../../../ice/src";
import { EventTarget as DomEventTarget } from "../helper";
import { debug, Event } from "../imports/common";
import {
  generateStatsId,
  getStatsTimestamp,
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCIceCandidateType,
  type RTCIceTcpCandidateType,
  type RTCStats,
  type RTCStatsIceCandidatePairState,
} from "../media/stats";
import { candidateToSdp } from "../sdp";
import {
  candidateFieldsFromValues,
  parseCandidateAttribute,
  type RTCIceCandidateFields,
  type RTCIceComponent,
  type RTCIceProtocol,
} from "./iceCandidateAttribute";

const log = debug("werift:packages/webrtc/src/transport/ice.ts");

function mapCandidatePairState(state: number): RTCStatsIceCandidatePairState {
  switch (state) {
    case 0:
      return "frozen";
    case 1:
      return "waiting";
    case 2:
      return "in-progress";
    case 3:
      return "succeeded";
    case 4:
      return "failed";
    default:
      return "failed";
  }
}

/**
 *                                          +------------+
                                            |            |
                                            |disconnected|
                                            |            |
                                            +------------+
                                            ^           ^
                                            |           |
+------+      +----------+      +-----------+      +----------+
|      |      |          |      |           |      |          |
| new  | ---> | checking | ---> | connected | ---> | completed|
|      |      |          |      |           |      |          |
+------+      +----+-----+      +-----------+      +----------+
                    |           
                    |           
                    v           
                +-------+       
                |       |      
                | failed|      
                |       |      
                +-------+      
 */

type StagedLocalRestart = {
  usernameFragment: string;
  password: string;
  candidates: IceCandidate[];
  emitted: boolean;
  /**
   * The generation gathers from its servers again after the commit (a new TURN
   * allocation, a fresh STUN mapping, changed ICE servers): its relay
   * candidates and end-of-candidates are trickled then, not with the offer.
   */
  endDeferred?: boolean;
  /** The remote offer an answer staged this generation for, if any. */
  answering?: object;
  /**
   * The kind of description that created it. The latest created offer and
   * the latest created answer each keep their generation registered.
   */
  createdBy: "offer" | "answer";
};

/**
 * ICE generations of one transport. An ICE restart (new ufrag/pwd without a
 * BUNDLE topology change) keeps the transport, its sockets and its DTLS
 * association: no role renegotiation, no second handshake (RFC 8842, JSEP).
 * Only a BUNDLE owner change creates a separate pending transport.
 *
 * Restart generations are registered by ufrag (`localGenerationFor`): the
 * latest created offer and the latest created answer each keep theirs until a
 * newer description of the same kind replaces it, whatever is applied, rolled
 * back or committed meanwhile. Applying a description selects the generation
 * its SDP carries, and the final answer switches exactly that one. A new offer
 * reuses the applied pending offer's generation (JSEP 5.2.1) unless
 * `restartIce()` asked to replace it; an answer created again reuses the
 * earlier answer's (JSEP 5.3.1).
 *
 * Provisional generation: while a restart of an established transport is
 * negotiated, a second checklist runs beside the live one on the same sockets.
 * It only exchanges STUN checks; RTP and DataChannel stay on the live selected
 * pair, and it follows the live checklist's rules (pair filter, ICE-lite,
 * nomination, staged-password error responses).
 *
 * - Created when the restart credentials are staged (`stageLocalRestart`): by
 *   `createOffer()` while a `restartIce()` request stands, or by
 *   `createAnswer()` for a remote offer that changes a live transport's ufrag.
 *   It then answers checks for that ufrag.
 * - Fed by the pranswer with the peer's credentials, candidates and
 *   end-of-candidates (`setProvisionalRemoteParams`,
 *   `addProvisionalRemoteCandidate`); a replacement pranswer restarts it.
 * - Checks start when the pranswer is applied (`startProvisionalChecks`); the
 *   controlling side nominates a provisional pair, but the live selected pair
 *   and send target never change. A response for an earlier checklist is
 *   ignored.
 * - Ends at the final answer, which recreates the live agent with the staged
 *   credentials and checks the answered generation from scratch, or at
 *   rollback / a replacement offer / selecting another generation, which
 *   stops its checks and keeps the live generation.
 *
 * A first negotiation and transports created for a proposal have no
 * provisional generation; they connect normally from the pranswer. The
 * staged-credential methods of `IceConnection` are optional: without them a
 * restart still happens at the final answer, without provisional checks.
 *
 * A restart generation's candidates are fixed when its description is
 * created (host candidates of the kept sockets and their server-reflexive
 * addresses) and are re-advertised at the commit without waiting. With STUN
 * or TURN servers the description carries neither the relay candidate nor
 * end-of-candidates: after the commit the generation gathers again (a new TURN
 * allocation replaces and closes the previous one) and trickles them. A
 * restart's background gathering that a later restart or `close()` replaced
 * signals nothing more. ICE server settings changed after gathering take
 * effect at the next restart (JSEP 4.1.18). The old selected pair is dropped
 * at the commit, so RTP pauses until the new generation nominates.
 */
export class RTCIceTransport {
  readonly id = randomUUID().toString();
  connection: IceConnection;
  state: RTCIceConnectionState = "new";
  readonly component = "rtp";
  iceRestarts = 0;
  private waitStart?: Event<[]>;
  /**
   * Connectivity checks were started for the current generation. A restart
   * resets it; the state alone cannot tell (an agent that finished gathering
   * reports "completed" before any check ran).
   * @internal
   */
  checksStarted = false;
  private renominating = false;
  /**
   * The restart generation selected for the description being created or
   * applied (the one createOffer / createAnswer put in its SDP, or the one an
   * applied description carries).
   */
  private stagedLocalRestart?: StagedLocalRestart;
  /**
   * The restart generations the latest created offer and the latest created
   * answer carry, by ufrag (their generation records). One stays registered
   * until a newer description of the same kind replaces it (unless an
   * applied description still carries it) or the transport stops, whatever
   * is applied, rolled back or committed meanwhile; applying a description
   * that carries it selects it (an ICE restart to those credentials on the
   * kept sockets).
   */
  private readonly localGenerations = new Map<string, StagedLocalRestart>();
  /**
   * The staged generation an applied description (pending local offer, or a
   * remote offer being answered) carries. It stays until that description is
   * committed, replaced or rolled back; an unapplied createOffer cannot drop it.
   */
  private appliedLocalRestart?: StagedLocalRestart;
  /**
   * Gatherer events of an ICE restart committed by a local answer, held until
   * that answer is applied (`emitCommittedCandidates`), in their order: the
   * re-advertised candidates first, then what the servers add and
   * end-of-candidates.
   */
  private heldCandidateEvents?: (IceCandidate | undefined)[];
  /**
   * ICE servers set (setConfiguration) after this transport gathered. They
   * apply to the next gathering, that is the next ICE restart (JSEP 4.1.18).
   */
  private nextGatherIceServers?: Partial<IceOptions>;
  private readonly events = new DomEventTarget();
  onstatechange?: () => void;
  ongatheringstatechange?: () => void;

  readonly onStateChange = new Event<[RTCIceConnectionState]>();
  readonly onIceCandidate = new Event<[IceCandidate | undefined]>();
  readonly onNegotiationNeeded = new Event<[]>();

  constructor(private iceGather: RTCIceGatherer) {
    this.connection = this.iceGather.connection;
    this.connection.stateChanged.subscribe((state) => {
      this.setState(state);
    });
    this.iceGather.onIceCandidate = (candidate) => {
      if (this.heldCandidateEvents) this.heldCandidateEvents.push(candidate);
      else this.onIceCandidate.execute(candidate);
    };
    this.iceGather.onGatheringStateChange.subscribe(() => {
      this.ongatheringstatechange?.();
      this.events.emit("gatheringstatechange");
    });
  }

  addEventListener = (
    type: string,
    listener: (...args: any[]) => void,
    options?: boolean | { once?: boolean },
  ) => {
    this.events.addEventListener(type, listener, options);
  };

  removeEventListener = (type: string, listener: (...args: any[]) => void) => {
    this.events.removeEventListener(type, listener);
  };

  dispatchEvent = (event: globalThis.Event) => this.events.dispatchEvent(event);

  get role() {
    if (!this.connection.remoteUsername || !this.connection.remotePassword) {
      return "unknown";
    }
    if (this.connection.iceControlling) return "controlling";
    else return "controlled";
  }

  get gatheringState() {
    return this.iceGather.gatheringState;
  }

  get localCandidates() {
    return this.describedLocalGeneration().candidates;
  }

  /** Whether the local description may carry `a=end-of-candidates`. */
  get localCandidatesComplete() {
    return this.describedLocalGeneration().complete;
  }

  /**
   * The local ICE generation a description carries: its credentials,
   * candidates and whether they are complete. A description being created
   * carries a staged restart. One already applied (refreshed when the live
   * generation gathers more) carries the staged restart only if it applied
   * it; a later createOffer() that staged another generation without applying
   * it does not change an applied description.
   * @internal
   */
  describedLocalGeneration({ applied = false }: { applied?: boolean } = {}) {
    const staged = this.stagedLocalRestart;
    if (!staged || (applied && staged !== this.appliedLocalRestart)) {
      return {
        parameters: this.iceGather.localParameters,
        candidates: this.iceGather.localCandidates,
        // The gatherer signals end-of-candidates (and the description that
        // records it refreshes) just before its state becomes "complete".
        complete:
          this.gatheringState === "complete" ||
          this.connection.localCandidatesEnd,
      };
    }
    const pending = this.stagedGatherPending();
    return {
      parameters: new RTCIceParameters({
        iceLite: this.connection.iceLite,
        usernameFragment: staged.usernameFragment,
        password: staged.password,
      }),
      candidates: pending
        ? staged.candidates.filter((candidate) => candidate.type !== "relay")
        : staged.candidates,
      complete: this.gatheringState === "complete" && !pending,
    };
  }

  /**
   * A staged restart whose generation keeps gathering from its servers after
   * the commit; its relay candidates and end-of-candidates come then.
   */
  private stagedGatherPending() {
    const staged = this.stagedLocalRestart;
    if (!staged) return false;
    if (staged.emitted) return !!staged.endDeferred;
    return !!this.nextGatherIceServers || !!this.connection.gathersFromServers;
  }

  get localParameters() {
    return this.describedLocalGeneration().parameters;
  }

  /**
   * Prepare an ICE generation for SDP without touching the selected pair.
   * `answering` is the remote offer an answer is created for.
   */
  stageLocalRestart({
    answering,
    replacing,
  }: {
    answering?: object;
    /** Credentials restartIce() asked to replace (W3C [[LocalIceCredentialsToReplace]]). */
    replacing?: ReadonlySet<string>;
  } = {}) {
    // The generation a description of this kind already carries is reused,
    // whatever was selected since: a new offer reuses the one of the pending
    // applied offer (JSEP 5.2.1) unless restartIce() asked to replace it, and
    // an answer created again for the same remote offer reuses the one the
    // earlier answer carries (JSEP 5.3.1).
    const applied = this.appliedLocalRestart;
    const reused = answering
      ? [...this.localGenerations.values()].find(
          (generation) => generation.answering === answering,
        )
      : applied && !replacing?.has(applied.usernameFragment)
        ? applied
        : undefined;
    if (reused) {
      this.selectGeneration(reused);
      return;
    }
    this.unselectLocalRestart();
    const usernameFragment = randomBytes(6).toString("base64url");
    const random = randomBytes(24).toString("base64url");
    // The configured prefix (icePasswordPrefix) marks every generation's
    // password, as the agent's own restart does.
    const prefix = this.connection.options.localPasswordPrefix ?? "";
    const password = prefix + random.slice(prefix.length);
    const candidates = this.iceGather.localCandidates.map((candidate) => {
      const copy = Object.assign(
        new IceCandidate(
          candidate.component,
          candidate.foundation,
          candidate.ip,
          candidate.port,
          candidate.priority,
          candidate.protocol,
          candidate.type,
          this.connection.generation + 1,
          usernameFragment,
        ),
        {
          relatedAddress: candidate.relatedAddress,
          relatedPort: candidate.relatedPort,
          tcpType: candidate.tcpType,
        },
      );
      return copy;
    });
    const generation: StagedLocalRestart = {
      usernameFragment,
      password,
      candidates,
      emitted: false,
      answering,
      createdBy: answering ? "answer" : "offer",
    };
    // The previous description of this kind is no longer the latest one.
    for (const [ufrag, previous] of this.localGenerations) {
      if (
        previous.createdBy === generation.createdBy &&
        previous !== this.appliedLocalRestart
      ) {
        this.localGenerations.delete(ufrag);
      }
    }
    this.localGenerations.set(usernameFragment, generation);
    this.stagedLocalRestart = generation;
    // Existing sockets can respond to provisional STUN checks for the new
    // ufrag while the old generation continues to carry media.
    this.connection.stageLocalCredentials?.(usernameFragment, password);
  }

  /**
   * The local generation a description with these credentials carries:
   * `"live"` for the agent's current credentials, the restart generation the
   * latest created offer or answer carries, or `undefined` when the
   * credentials belong to no generation the transport can take.
   * @internal
   */
  localGenerationFor(usernameFragment: string, password: string) {
    const live = this.iceGather.localParameters;
    if (
      live.usernameFragment === usernameFragment &&
      live.password === password
    ) {
      return "live" as const;
    }
    const generation = this.localGenerations.get(usernameFragment);
    if (generation?.password === password) return generation;
    return undefined;
  }

  /**
   * Select the local generation an applied description carries (see
   * `localGenerationFor`). Returns false if the credentials belong to none.
   * @internal
   */
  selectLocalGeneration(usernameFragment: string, password: string) {
    const generation = this.localGenerationFor(usernameFragment, password);
    if (!generation) return false;
    if (generation === "live") {
      this.unselectLocalRestart();
      return true;
    }
    this.selectGeneration(generation);
    return true;
  }

  private selectGeneration(generation: StagedLocalRestart) {
    if (this.stagedLocalRestart === generation) return;
    this.unselectLocalRestart();
    this.stagedLocalRestart = generation;
    this.connection.stageLocalCredentials?.(
      generation.usernameFragment,
      generation.password,
    );
  }

  /** Stop answering checks for the selected generation; it stays registered. */
  private unselectLocalRestart() {
    const staged = this.stagedLocalRestart;
    if (!staged) return;
    this.connection.discardStagedLocalCredentials?.(staged.usernameFragment);
    this.stagedLocalRestart = undefined;
  }

  get hasStagedRestart() {
    return !!this.stagedLocalRestart;
  }

  /** Feed a pranswer's ICE generation to the provisional checklist. */
  setProvisionalRemoteParams(remoteParameters: RTCIceParameters) {
    if (!this.stagedLocalRestart) return;
    this.connection.setProvisionalRemoteParams?.(remoteParameters);
  }

  addProvisionalRemoteCandidate(candidate?: IceCandidate) {
    if (!this.stagedLocalRestart) return;
    return this.connection.addProvisionalRemoteCandidate?.(
      candidate ? candidateToIce(candidate) : undefined,
    );
  }

  /**
   * Hand a remote candidate (`undefined`: end-of-candidates) to the ICE agent
   * without waiting for it. A host candidate is added synchronously; an mDNS
   * name may take seconds to resolve, and the agent itself orders that
   * resolution against end-of-candidates and generation changes, so the
   * description operation queue must not wait for it.
   */
  deliverRemoteCandidate(candidate?: IceCandidate) {
    void Promise.resolve(this.addRemoteCandidate(candidate)).catch((error) =>
      log("addRemoteCandidate failed", error),
    );
  }

  /** `deliverRemoteCandidate` for the provisional (pranswer) generation. */
  deliverProvisionalRemoteCandidate(candidate?: IceCandidate) {
    void Promise.resolve(this.addProvisionalRemoteCandidate(candidate)).catch(
      (error) => log("addProvisionalRemoteCandidate failed", error),
    );
  }

  startProvisionalChecks() {
    if (!this.stagedLocalRestart) return;
    this.connection.startProvisionalChecks?.();
  }

  emitStagedCandidates() {
    const staged = this.stagedLocalRestart;
    if (!staged || staged.emitted) return;
    const candidates = this.localCandidates;
    staged.endDeferred = this.stagedGatherPending();
    staged.emitted = true;
    for (const candidate of candidates) {
      // A copy: the listener rewrites the event's foundation and m-line,
      // while these candidates still render the local description.
      this.onIceCandidate.execute(
        Object.assign(
          Object.create(Object.getPrototypeOf(candidate)),
          candidate,
        ) as IceCandidate,
      );
    }
    if (!staged.endDeferred) this.onIceCandidate.execute(undefined);
  }

  rollbackLocalRestart() {
    this.appliedLocalRestart = undefined;
    // A description applying this generation again signals its candidates
    // again (the remote side rolled back too).
    if (this.stagedLocalRestart) this.stagedLocalRestart.emitted = false;
    this.unselectLocalRestart();
  }

  /** The staged generation now belongs to an applied description. */
  markLocalRestartApplied() {
    this.appliedLocalRestart = this.stagedLocalRestart;
  }

  /** Drop only what an unapplied createOffer staged; keep the applied one. */
  discardUnappliedLocalRestart() {
    const staged = this.stagedLocalRestart;
    const applied = this.appliedLocalRestart;
    if (!staged || staged === applied) return;
    this.unselectLocalRestart();
    if (applied) {
      this.stagedLocalRestart = applied;
      this.connection.stageLocalCredentials?.(
        applied.usernameFragment,
        applied.password,
      );
    }
  }

  /**
   * Called unconditionally on every answer; actually restarts ICE only if
   * this transport has a staged local restart. No-op otherwise.
   */
  async commitLocalRestartIfStaged() {
    const staged = this.stagedLocalRestart;
    if (!staged) return;
    // The description already finalized this generation's candidates with
    // end-of-candidates: it only re-advertises the kept sockets, and a server
    // change waits for the next restart. Otherwise the generation keeps
    // gathering from its servers (a fresh STUN mapping, a new TURN allocation)
    // after the commit and trickles what they add.
    const regather = this.stagedGatherPending();
    this.restart(false, regather);
    if (this.connection.commitLocalCredentials) {
      this.connection.commitLocalCredentials(
        staged.usernameFragment,
        staged.password,
      );
    } else {
      this.connection.localUsername = staged.usernameFragment;
      this.connection.localPassword = staged.password;
    }
    this.stagedLocalRestart = undefined;
    this.appliedLocalRestart = undefined;
    // A local answer signals its candidates after it is applied.
    if (!staged.emitted) this.heldCandidateEvents = [];
    // The generation is live now. Its registration stays with the
    // description that carries it (a later commit of another generation does
    // not end it): applying that description again restarts to it, and its
    // candidates are signalled again then.
    staged.emitted = false;
    staged.endDeferred = undefined;
    // The kept sockets are re-advertised synchronously; nothing here waits
    // for a server, so the commit never holds the new generation's checks.
    const gathering = this.gather();
    if (regather) {
      void gathering.catch((error) => log("restart gathering failed", error));
    } else {
      await gathering;
    }
  }

  /** Signal the candidates an ICE restart committed by a local answer gathered. */
  emitCommittedCandidates() {
    const held = this.heldCandidateEvents;
    if (!held) return;
    this.heldCandidateEvents = undefined;
    for (const candidate of held) {
      this.onIceCandidate.execute(candidate);
    }
  }

  getRemoteCandidates() {
    return this.connection.remoteCandidates
      .filter((candidate) => candidate.type !== "prflx")
      .map((candidate) => candidateFromIce(candidate).toJSON());
  }

  getLocalCandidates() {
    return this.connection.localCandidates.map((candidate) =>
      candidateFromIce(candidate).toJSON(),
    );
  }

  getSelectedCandidatePair() {
    const pair =
      this.connection.candidatePairs.find((candidate) => candidate.nominated) ??
      this.connection.candidatePairs.find((candidate) => candidate.state === 3);
    if (!pair) {
      return null;
    }

    return {
      local: candidateFromIce(pair.localCandidate).toJSON(),
      remote: candidateFromIce(pair.remoteCandidate).toJSON(),
    };
  }

  getLocalParameters() {
    return this.localParameters ?? null;
  }

  getRemoteParameters() {
    if (!this.connection.remoteUsername || !this.connection.remotePassword) {
      return null;
    }

    return new RTCIceParameters({
      iceLite: this.connection.remoteIsLite,
      password: this.connection.remotePassword,
      usernameFragment: this.connection.remoteUsername,
    });
  }

  private setState(state: RTCIceConnectionState, emitEvent = true) {
    // closed is final: checks that stop() interrupted must not report
    // "failed" (or anything else) afterwards.
    if (this.state === "closed") return;
    if (state !== this.state) {
      this.state = state;

      this.onStateChange.execute(state);
      if (emitEvent) {
        this.onstatechange?.();
        this.events.emit("statechange");
      }
    }
  }

  gather() {
    return this.iceGather.gather();
  }

  setIceServers(options: Partial<IceOptions>) {
    this.nextGatherIceServers = undefined;
    this.iceGather.setIceServers(options);
  }

  /** Keep ICE servers for the next gathering (an ICE restart). */
  deferIceServers(options: Partial<IceOptions>) {
    this.nextGatherIceServers = options;
  }

  addRemoteCandidate = (candidate?: IceCandidate) => {
    if (!this.connection.remoteCandidatesEnd) {
      return !candidate
        ? this.connection.addRemoteCandidate(undefined)
        : this.connection.addRemoteCandidate(candidateToIce(candidate));
    }
  };

  /**
   * `keepLocalCredentials`: the remote credentials come from an answer or
   * pranswer, so the local ones are fixed by the applied local offer. Changed
   * remote credentials restart the checks for the new remote generation
   * without new local credentials (nothing would describe them to the peer).
   */
  setRemoteParams(
    remoteParameters: RTCIceParameters,
    renomination = false,
    { keepLocalCredentials = false }: { keepLocalCredentials?: boolean } = {},
  ) {
    if (renomination) {
      this.renominating = true;
    }
    if (
      this.connection.remoteUsername &&
      this.connection.remotePassword &&
      (this.connection.remoteUsername !== remoteParameters.usernameFragment ||
        this.connection.remotePassword !== remoteParameters.password)
    ) {
      if (this.renominating) {
        log("renomination", remoteParameters);
        this.connection.resetNominatedPair();
        // The kept checklist holds only the new remote generation's
        // candidates (and ones without a ufrag, as develop kept them).
        this.connection.dropOtherRemoteGenerations?.(
          remoteParameters.usernameFragment,
        );
        this.renominating = false;
      } else if (keepLocalCredentials && this.connection.restartRemote) {
        log("remote restart", remoteParameters);
        this.resetRemoteGeneration();
      } else {
        log("restart", remoteParameters);
        this.restart();
      }
    }
    this.connection.setRemoteParams(remoteParameters);
  }

  /**
   * Internal: drop the remote generation and its checks, keeping the local
   * credentials and candidates a description already carries (a remote-only
   * restart, or a proposal transport a replacement pranswer left unused).
   */
  resetRemoteGeneration() {
    if (!this.connection.restartRemote) return;
    this.connection.restartRemote();
    this.setState("new");
    this.waitStart = undefined;
    this.checksStarted = false;
  }

  restart(notifyNegotiation = true, applyNextGatherIceServers = true) {
    this.iceRestarts++;
    this.connection.restart();
    const servers = this.nextGatherIceServers;
    if (servers && applyNextGatherIceServers) this.setIceServers(servers);
    this.setState("new");
    // Use setGatheringState so onGatheringStateChange fires and the
    // SecureTransportManager aggregate iceGatheringState stays in sync.
    this.iceGather.setGatheringState("new");
    this.waitStart = undefined;
    this.checksStarted = false;
    if (notifyNegotiation) this.onNegotiationNeeded.execute();
  }

  async start() {
    if (this.state === "closed") {
      throw new Error("RTCIceTransport is closed");
    }
    if (!this.connection.remotePassword || !this.connection.remoteUsername) {
      throw new Error("remoteParams missing");
    }

    if (this.waitStart) {
      await this.waitStart.asPromise();
    }
    const waitStart = new Event<[]>();
    this.waitStart = waitStart;
    this.checksStarted = true;

    this.setState("checking");

    try {
      await this.connection.connect();
    } catch (error) {
      this.setState("failed");
      throw error;
    } finally {
      // A failed start releases its waiters too.
      if (!waitStart.ended) {
        waitStart.execute();
        waitStart.complete();
      }
      if (this.waitStart === waitStart) this.waitStart = undefined;
    }
  }

  /**
   * Settles when the checks a running start() makes finish (at once if none run).
   * @internal
   */
  async checksSettled() {
    const waitStart = this.waitStart;
    if (waitStart) await waitStart.asPromise();
  }

  async stop() {
    this.localGenerations.clear();
    // Whoever awaits the checks of this transport settles now (checksSettled).
    const waitStart = this.waitStart;
    this.waitStart = undefined;
    if (waitStart && !waitStart.ended) {
      waitStart.execute();
      waitStart.complete();
    }
    if (this.state !== "closed") {
      this.setState("closed", false);
      await this.connection.close();
    }
    this.onStateChange.complete();
    this.onIceCandidate.complete();
    this.onNegotiationNeeded.complete();
  }

  async getStats(
    timestamp = getStatsTimestamp(),
    transportId = generateStatsId("transport", this.id),
  ): Promise<RTCStats[]> {
    const stats: RTCStats[] = [];

    // Local candidates
    for (const candidate of this.connection.localCandidates) {
      const candidateStats: RTCIceCandidateStats = {
        type: "local-candidate",
        id: generateStatsId("local-candidate", candidate.id),
        timestamp,
        transportId,
        address: candidate.host,
        port: candidate.port,
        protocol: candidate.transport,
        candidateType: candidate.type as any,
        priority: candidate.priority,
        foundation: candidate.foundation,
        relatedAddress: candidate.relatedAddress,
        relatedPort: candidate.relatedPort,
        usernameFragment: candidate.ufrag,
        tcpType: candidate.tcptype as any,
      };
      stats.push(candidateStats);
    }

    // Remote candidates
    for (const candidate of this.connection.remoteCandidates) {
      const candidateStats: RTCIceCandidateStats = {
        type: "remote-candidate",
        id: generateStatsId("remote-candidate", candidate.id),
        timestamp,
        transportId,
        address: candidate.host,
        port: candidate.port,
        protocol: candidate.transport,
        candidateType: candidate.type as any,
        priority: candidate.priority,
        foundation: candidate.foundation,
        relatedAddress: candidate.relatedAddress,
        relatedPort: candidate.relatedPort,
        usernameFragment: candidate.ufrag,
        tcpType: candidate.tcptype as any,
      };
      stats.push(candidateStats);
    }

    // Candidate pairs
    const pairs = this.connection?.candidatePairs
      ? [
          ...this.connection.candidatePairs.filter((p) => p.nominated),
          ...this.connection.candidatePairs.filter((p) => !p.nominated),
        ]
      : [];
    for (const pair of pairs) {
      const pairStats: RTCIceCandidatePairStats = {
        type: "candidate-pair",
        id: generateStatsId("candidate-pair", pair.id),
        timestamp,
        transportId,
        localCandidateId: generateStatsId(
          "local-candidate",
          pair.localCandidate.id,
        ),
        remoteCandidateId: generateStatsId(
          "remote-candidate",
          pair.remoteCandidate.id,
        ),
        state: mapCandidatePairState(pair.state),
        nominated: pair.nominated,
        packetsSent: pair.packetsSent,
        packetsReceived: pair.packetsReceived,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        currentRoundTripTime: pair.rtt,
        totalRoundTripTime: pair.totalRoundTripTime,
        roundTripTimeMeasurements: pair.roundTripTimeMeasurements,
        requestsReceived: pair.requestsReceived,
        requestsSent: pair.requestsSent,
        responsesReceived: pair.responsesReceived,
        responsesSent: pair.responsesSent,
        retransmissionsReceived: pair.retransmissionsReceived,
        retransmissionsSent: pair.retransmissionsSent,
        consentRequestsSent: pair.consentRequestsSent,
      };
      stats.push(pairStats);
    }

    return stats;
  }
}

export const IceTransportStates = [
  "new",
  "checking",
  "connected",
  "completed",
  "disconnected",
  "failed",
  "closed",
] as const;
export type RTCIceConnectionState = (typeof IceTransportStates)[number];

export const IceGathererStates = ["new", "gathering", "complete"] as const;
export type IceGathererState = (typeof IceGathererStates)[number];

export class RTCIceGatherer {
  onIceCandidate: (candidate: IceCandidate | undefined) => void = () => {};
  gatheringState: IceGathererState = "new";
  readonly connection: IceConnection;

  readonly onGatheringStateChange = new Event<[IceGathererState]>();

  constructor(private options: Partial<IceOptions> = {}) {
    this.connection = new Connection(false, this.options);
    this.connection.onIceCandidate.subscribe((candidate) => {
      this.onIceCandidate(candidateFromIce(candidate));
    });
  }

  async gather() {
    if (this.gatheringState === "new") {
      this.setState("gathering");
      const generation = this.connection.generation;
      await this.connection.gatherCandidates();
      // Gathering an ICE restart (or close) replaced in the meantime does not
      // complete the new generation: that one signals its own end.
      if (
        this.connection.generation !== generation ||
        this.connection.state === "closed"
      ) {
        return;
      }
      this.onIceCandidate(undefined);
      this.setState("complete");
    }
  }

  setIceServers(options: Partial<IceOptions>) {
    this.connection.setIceServers(options);
  }

  /**
   * Set gathering state and notify listeners.
   * ICE restart must use this instead of writing gatheringState directly so
   * SecureTransportManager can refresh its aggregate iceGatheringState.
   */
  setGatheringState(state: IceGathererState) {
    this.setState(state);
  }

  get localCandidates() {
    return this.connection.localCandidates.map(candidateFromIce);
  }

  get localParameters() {
    const params = new RTCIceParameters({
      iceLite: this.connection.iceLite,
      usernameFragment: this.connection.localUsername,
      password: this.connection.localPassword,
    });

    return params;
  }

  private setState(state: IceGathererState) {
    if (state !== this.gatheringState) {
      this.gatheringState = state;
      this.onGatheringStateChange.execute(state);
    }
  }
}

export function candidateFromIce(c: Candidate) {
  const candidate = new IceCandidate(
    c.component,
    c.foundation,
    c.host,
    c.port,
    c.priority,
    c.transport,
    c.type,
    c.generation,
    c.ufrag,
  );
  candidate.relatedAddress = c.relatedAddress;
  candidate.relatedPort = c.relatedPort;
  candidate.tcpType = c.tcptype;
  return candidate;
}

export function candidateToIce(x: IceCandidate) {
  return new Candidate(
    x.foundation,
    x.component,
    x.protocol,
    x.priority,
    x.ip,
    x.port,
    x.type,
    x.relatedAddress,
    x.relatedPort,
    x.tcpType,
    x.generation,
    x.ufrag,
  );
}

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMLineIndex?: number | null;
  sdpMid?: string | null;
  usernameFragment?: string | null;
}

export type {
  RTCIceCandidateFields,
  RTCIceComponent,
  RTCIceProtocol,
} from "./iceCandidateAttribute";

/** Module-private key for handing already parsed fields to the constructor. */
const parsedFields = Symbol("RTCIceCandidate.parsedFields");

/** Create an `RTCIceCandidate` whose fields come from typed values, without reparsing. */
function createRTCIceCandidate(
  init: RTCIceCandidateInit,
  fields: RTCIceCandidateFields,
) {
  return new RTCIceCandidate({
    ...init,
    [parsedFields]: fields,
  } as RTCIceCandidateInit);
}

/**
 * Browser-shaped ICE candidate. Besides the signaling fields it exposes the
 * readonly fields of the W3C interface parsed from the candidate a-line
 * (`foundation`, `component`, `priority`, `address`, `protocol`, `port`,
 * `type`, `tcpType`, `relatedAddress`, `relatedPort`). Which candidates give
 * `null` fields is specified on {@link RTCIceCandidateFields}. Candidates
 * werift creates carry them without reparsing; `toJSON()` keeps only the
 * signaling fields (RTCIceCandidateInit). `relayProtocol` and `url` are not
 * implemented.
 */
export class RTCIceCandidate implements RTCIceCandidateFields {
  candidate: string = "";
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;

  readonly foundation!: string | null;
  readonly component!: RTCIceComponent | null;
  readonly priority!: number | null;
  readonly address!: string | null;
  readonly protocol!: RTCIceProtocol | null;
  readonly port!: number | null;
  readonly type!: RTCIceCandidateType | null;
  readonly tcpType!: RTCIceTcpCandidateType | null;
  readonly relatedAddress!: string | null;
  readonly relatedPort!: number | null;

  /**
   * Like the browser constructor, only the `RTCIceCandidateInit` members are
   * read; the parsed fields always come from `init.candidate` (`""` when
   * omitted).
   */
  constructor(init: RTCIceCandidateInit = {}) {
    const { sdpMid, sdpMLineIndex, usernameFragment } = init;
    const candidate = init.candidate ?? "";
    const fields =
      (init as { [parsedFields]?: RTCIceCandidateFields })[parsedFields] ??
      candidateFieldsFromValues(parseCandidateAttribute(candidate));
    Object.assign(this, fields, {
      candidate,
      sdpMid,
      sdpMLineIndex,
      usernameFragment,
    });
  }

  /** Same as `new RTCIceCandidate({ candidate: sdp })`. */
  static fromSdp(sdp: string): RTCIceCandidate {
    return new RTCIceCandidate({ candidate: sdp });
  }

  static isThis(o: any) {
    if (typeof o?.candidate === "string") return true;
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

export class IceCandidate {
  // """
  // The :class:`RTCIceCandidate` interface represents a candidate Interactive
  // Connectivity Establishment (ICE) configuration which may be used to
  // establish an RTCPeerConnection.
  // """
  public relatedAddress?: string;
  public relatedPort?: number;
  public sdpMid?: string;
  public sdpMLineIndex?: number;
  public tcpType?: string;

  constructor(
    public component: number,
    public foundation: string,
    public ip: string,
    public port: number,
    public priority: number,
    public protocol: string,
    public type: string,
    public generation?: number,
    public ufrag?: string,
  ) {}

  /** The parsed fields are validated from these typed values, not by reparsing. */
  toJSON(): RTCIceCandidate {
    return createRTCIceCandidate(
      {
        candidate: candidateToSdp(this),
        sdpMLineIndex: this.sdpMLineIndex,
        sdpMid: this.sdpMid,
        usernameFragment: this.ufrag,
      },
      candidateFieldsFromValues(this),
    );
  }

  /**
   * Returns `undefined` when `data.candidate` is empty or violates the grammar
   * documented on {@link RTCIceCandidateFields}.
   */
  static fromJSON(data: RTCIceCandidate | RTCIceCandidateInit) {
    const values = parseCandidateAttribute(data.candidate ?? "");
    if (!values) return;
    const candidate = new IceCandidate(
      values.component,
      values.foundation,
      values.ip,
      values.port,
      values.priority,
      values.protocol,
      values.type,
      values.generation,
      values.ufrag,
    );
    candidate.relatedAddress = values.relatedAddress;
    candidate.relatedPort = values.relatedPort;
    candidate.tcpType = values.tcpType;
    candidate.sdpMLineIndex = data.sdpMLineIndex ?? undefined;
    candidate.sdpMid = data.sdpMid ?? undefined;
    return candidate;
  }
}

export class RTCIceParameters {
  iceLite = false;
  usernameFragment!: string;
  password!: string;

  constructor(props: Partial<RTCIceParameters> = {}) {
    Object.assign(this, props);
  }
}
