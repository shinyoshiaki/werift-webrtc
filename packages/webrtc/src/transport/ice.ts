import { randomUUID } from "crypto";
import { Event, debug } from "../imports/common";

import {
  Candidate,
  Connection,
  type IceConnection,
  type IceOptions,
} from "../../../ice/src";
import {
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCStats,
  generateStatsId,
  getStatsTimestamp,
} from "../media/stats";
import { candidateFromSdp, candidateToSdp } from "../sdp";

const log = debug("werift:packages/webrtc/src/transport/ice.ts");

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

export class RTCIceTransport {
  readonly id = randomUUID().toString();
  connection: IceConnection;
  state: RTCIceConnectionState = "new";
  private waitStart?: Event<[]>;
  private renominating = false;

  readonly onStateChange = new Event<[RTCIceConnectionState]>();
  readonly onIceCandidate = new Event<[IceCandidate | undefined]>();
  readonly onNegotiationNeeded = new Event<[]>();

  constructor(private iceGather: RTCIceGatherer) {
    this.connection = this.iceGather.connection;
    this.connection.stateChanged.subscribe((state) => {
      this.setState(state);
    });
    this.iceGather.onIceCandidate = (candidate) => {
      this.onIceCandidate.execute(candidate);
    };
  }

  get role() {
    if (this.connection.iceControlling) return "controlling";
    else return "controlled";
  }

  get gatheringState() {
    return this.iceGather.gatheringState;
  }

  get localCandidates() {
    return this.iceGather.localCandidates;
  }

  get localParameters() {
    return this.iceGather.localParameters;
  }

  private setState(state: RTCIceConnectionState) {
    if (state !== this.state) {
      this.state = state;

      this.onStateChange.execute(state);
    }
  }

  gather() {
    return this.iceGather.gather();
  }

  addRemoteCandidate = (candidate?: IceCandidate) => {
    if (!this.connection.remoteCandidatesEnd) {
      if (!candidate) {
        return this.connection.addRemoteCandidate(undefined);
      } else {
        return this.connection.addRemoteCandidate(candidateToIce(candidate));
      }
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

  restart() {
    this.connection.restart();
    this.setState("new");
    this.iceGather.gatheringState = "new";
    this.waitStart = undefined;
    this.onNegotiationNeeded.execute();
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
    this.waitStart = new Event();

    this.setState("checking");

    try {
      await this.connection.connect();
    } catch (error) {
      this.setState("failed");
      throw error;
    }

    this.waitStart.execute();
    this.waitStart.complete();
    this.waitStart = undefined;
  }

  async stop() {
    if (this.state !== "closed") {
      this.setState("closed");
      await this.connection.close();
    }
    this.onStateChange.complete();
    this.onIceCandidate.complete();
    this.onNegotiationNeeded.complete();
  }

  async getStats(): Promise<RTCStats[]> {
    const timestamp = getStatsTimestamp();
    const stats: RTCStats[] = [];

    // Local candidates
    for (const candidate of this.localCandidates) {
      const candidateStats: RTCIceCandidateStats = {
        type: "local-candidate",
        id: generateStatsId("local-candidate", candidate.foundation),
        timestamp,
        transportId: generateStatsId("transport", this.id),
        address: candidate.ip,
        port: candidate.port,
        protocol: candidate.protocol,
        candidateType: candidate.type as any,
        priority: candidate.priority,
        foundation: candidate.foundation,
      };
      stats.push(candidateStats);
    }

    // Remote candidates
    for (const candidate of this.connection.remoteCandidates) {
      const ice = candidateFromIce(candidate);
      const candidateStats: RTCIceCandidateStats = {
        type: "remote-candidate",
        id: generateStatsId("remote-candidate", ice.foundation),
        timestamp,
        transportId: generateStatsId("transport", this.id),
        address: ice.ip,
        port: ice.port,
        protocol: ice.protocol,
        candidateType: ice.type as any,
        priority: ice.priority,
        foundation: ice.foundation,
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
        id: generateStatsId("candidate-pair", pair.foundation),
        timestamp,
        transportId: generateStatsId("transport", this.id),
        localCandidateId: generateStatsId(
          "local-candidate",
          pair.localCandidate.foundation,
        ),
        remoteCandidateId: generateStatsId(
          "remote-candidate",
          pair.remoteCandidate.foundation,
        ),
        state: pair.state as any,
        nominated: pair.nominated,
        packetsSent: pair.packetsSent,
        packetsReceived: pair.packetsReceived,
        bytesSent: pair.bytesSent,
        bytesReceived: pair.bytesReceived,
        currentRoundTripTime: pair.rtt,
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
      await this.connection.gatherCandidates();
      this.onIceCandidate(undefined);
      this.setState("complete");
    }
  }

  get localCandidates() {
    return this.connection.localCandidates.map(candidateFromIce);
  }

  get localParameters() {
    const params = new RTCIceParameters({
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
      const candidate = candidateFromSdp(data.candidate);
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
