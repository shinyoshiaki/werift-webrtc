import debug from "debug";
import Event from "rx.mini";
import { v4 } from "uuid";

import { Candidate, Connection, IceOptions } from "../../../ice/src";
import { candidateFromSdp, candidateToSdp } from "../sdp";

const log = debug("werift:packages/webrtc/src/transport/ice.ts");

export class RTCIceTransport {
  readonly id = v4();
  connection: Connection;
  state: RTCIceConnectionState = "new";

  readonly onStateChange = new Event<[RTCIceConnectionState]>();

  private waitStart?: Event<[]>;

  constructor(private gather: RTCIceGatherer) {
    this.connection = this.gather.connection;
    this.connection.stateChanged.subscribe((state) => {
      this.setState(state);
    });
  }

  get iceGather() {
    return this.gather;
  }

  get role() {
    if (this.connection.iceControlling) return "controlling";
    else return "controlled";
  }

  private setState(state: RTCIceConnectionState) {
    if (state !== this.state) {
      this.state = state;

      if (this.onStateChange.ended) return;

      if (state === "closed") {
        this.onStateChange.execute(state);
        this.onStateChange.complete();
      } else {
        this.onStateChange.execute(state);
      }
    }
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

  setRemoteParams(remoteParameters: RTCIceParameters) {
    if (
      this.connection.remoteUsername &&
      this.connection.remotePassword &&
      (this.connection.remoteUsername !== remoteParameters.usernameFragment ||
        this.connection.remotePassword !== remoteParameters.password)
    ) {
      log("restartIce", remoteParameters);
      this.connection.resetNominatedPair();
    }
    this.connection.setRemoteParams(remoteParameters);
  }

  async start() {
    if (this.state === "closed") throw new Error("RTCIceTransport is closed");
    if (!this.connection.remotePassword || !this.connection.remoteUsername)
      throw new Error("remoteParams missing");

    if (this.waitStart) await this.waitStart.asPromise();
    this.waitStart = new Event();

    this.setState("checking");

    try {
      await this.connection.connect();
    } catch (error) {
      this.setState("failed");
      throw error;
    }

    this.waitStart.complete();
  }

  async stop() {
    if (this.state !== "closed") {
      this.setState("closed");
      await this.connection.close();
    }
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
export type RTCIceConnectionState = typeof IceTransportStates[number];

export const IceGathererStates = ["new", "gathering", "complete"] as const;
export type IceGathererState = typeof IceGathererStates[number];

export class RTCIceGatherer {
  onIceCandidate: (candidate: IceCandidate) => void = () => {};
  gatheringState: IceGathererState = "new";

  readonly onGatheringStateChange = new Event<[IceGathererState]>();
  readonly connection: Connection;

  constructor(private options: Partial<IceOptions> = {}) {
    this.connection = new Connection(false, this.options);
  }

  async gather() {
    if (this.gatheringState === "new") {
      this.setState("gathering");
      await this.connection.gatherCandidates((candidate) =>
        this.onIceCandidate(candidateFromIce(candidate))
      );
      this.setState("complete");
    }
  }

  get localCandidates() {
    return this.connection.localCandidates.map(candidateFromIce);
  }

  get localParameters() {
    const params = new RTCIceParameters({
      usernameFragment: this.connection.localUserName,
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
    c.type
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
    x.tcpType
  );
}

export class RTCIceCandidate {
  candidate!: string;
  sdpMid?: string;
  sdpMLineIndex?: number;

  constructor(props: Partial<RTCIceCandidate>) {
    Object.assign(this, props);
  }

  static isThis(o: any) {
    if (typeof o?.candidate === "string") return true;
  }

  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
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
    public type: string
  ) {}

  toJSON(): RTCIceCandidate {
    return new RTCIceCandidate({
      candidate: candidateToSdp(this),
      sdpMLineIndex: this.sdpMLineIndex,
      sdpMid: this.sdpMid,
    });
  }

  static fromJSON(data: RTCIceCandidate) {
    try {
      const candidate = candidateFromSdp(data.candidate);
      candidate.sdpMLineIndex = data.sdpMLineIndex;
      candidate.sdpMid = data.sdpMid;
      return candidate;
    } catch (error) {}
  }
}

export class RTCIceParameters {
  iceLite: boolean = false;
  usernameFragment!: string;
  password!: string;

  constructor(props: Partial<RTCIceParameters> = {}) {
    Object.assign(this, props);
  }
}
