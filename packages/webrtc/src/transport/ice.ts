import { randomBytes, randomUUID } from "crypto";
import { Event, debug } from "../imports/common";

import {
  Candidate,
  Connection,
  type IceConnection,
  type IceOptions,
} from "../../../ice/src";
import { EventTarget as DomEventTarget } from "../helper";
import {
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCStats,
  type RTCStatsIceCandidatePairState,
  generateStatsId,
  getStatsTimestamp,
} from "../media/stats";
import { candidateFromSdp, candidateToSdp } from "../sdp";

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
};

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
  private stagedLocalRestart?: StagedLocalRestart;
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
    const staged = this.stagedLocalRestart;
    if (!staged) return this.iceGather.localCandidates;
    return this.stagedGatherPending()
      ? staged.candidates.filter((candidate) => candidate.type !== "relay")
      : staged.candidates;
  }

  /** Whether the local description may carry `a=end-of-candidates`. */
  get localCandidatesComplete() {
    return this.gatheringState === "complete" && !this.stagedGatherPending();
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
    const pending = this.stagedLocalRestart;
    return pending
      ? new RTCIceParameters({
          iceLite: this.connection.iceLite,
          usernameFragment: pending.usernameFragment,
          password: pending.password,
        })
      : this.iceGather.localParameters;
  }

  /** Prepare an ICE generation for SDP without touching the selected pair. */
  stageLocalRestart() {
    // JSEP 5.2.1: a new offer reuses the credentials of the pending applied
    // offer, which already restarts ICE.
    if (
      this.stagedLocalRestart &&
      this.stagedLocalRestart === this.appliedLocalRestart
    ) {
      return;
    }
    this.rollbackLocalRestart();
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
    this.stagedLocalRestart = {
      usernameFragment,
      password,
      candidates,
      emitted: false,
    };
    // Existing sockets can respond to provisional STUN checks for the new
    // ufrag while the old generation continues to carry media.
    this.connection.stageLocalCredentials?.(usernameFragment, password);
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
      this.onIceCandidate.execute(candidate);
    }
    if (!staged.endDeferred) this.onIceCandidate.execute(undefined);
  }

  rollbackLocalRestart() {
    this.appliedLocalRestart = undefined;
    if (!this.stagedLocalRestart) return;
    this.connection.discardStagedLocalCredentials?.(
      this.stagedLocalRestart.usernameFragment,
    );
    this.stagedLocalRestart = undefined;
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
    this.connection.discardStagedLocalCredentials?.(staged.usernameFragment);
    this.stagedLocalRestart = applied;
    if (applied) {
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

  setRemoteParams(remoteParameters: RTCIceParameters, renomination = false) {
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
        this.renominating = false;
      } else {
        log("restart", remoteParameters);
        this.restart();
      }
    }
    this.connection.setRemoteParams(remoteParameters);
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
      waitStart.execute();
      waitStart.complete();
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

export class RTCIceCandidate {
  candidate!: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;

  constructor(props: Partial<RTCIceCandidate>) {
    Object.assign(this, props);
  }

  static fromSdp(sdp: string): RTCIceCandidate {
    const ice = Candidate.fromSdp(sdp);
    const candidate = candidateFromIce(ice);
    return candidate.toJSON();
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

  toJSON(): RTCIceCandidate {
    return new RTCIceCandidate({
      candidate: candidateToSdp(this),
      sdpMLineIndex: this.sdpMLineIndex,
      sdpMid: this.sdpMid,
      usernameFragment: this.ufrag,
    });
  }

  static fromJSON(data: RTCIceCandidate | RTCIceCandidateInit) {
    try {
      if (!data.candidate) {
        throw new Error("candidate is required");
      }
      const normalizedCandidate = data.candidate.startsWith("candidate:")
        ? data.candidate.slice("candidate:".length)
        : data.candidate;
      const candidate = candidateFromSdp(normalizedCandidate);
      candidate.sdpMLineIndex = data.sdpMLineIndex ?? undefined;
      candidate.sdpMid = data.sdpMid ?? undefined;
      return candidate;
    } catch (error) {}
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
