import { Connection, Candidate } from "../../vendor/ice";
import Event from "rx.mini";
import { candidateFromSdp, candidateToSdp } from "../sdp";

export type IceState =
  | "new"
  | "gathering"
  | "stateChange"
  | "completed"
  | "closed"
  | "checking"
  | "failed"
  | "disconnected";

export class RTCIceGatherer {
  subject = new Event<IceState>();
  onIceCandidate: (candidate: RTCIceCandidate) => void = () => {};
  private _state: IceState = "new";
  connection: Connection;
  constructor(stunServer?: [string, number]) {
    this.connection = new Connection(false, { stunServer });
  }

  get state() {
    return this._state;
  }

  async gather() {
    if (this._state === "new") {
      this.setState("gathering");
      await this.connection.gatherCandidates((candidate) =>
        this.onIceCandidate(candidateFromIce(candidate))
      );
      this.setState("completed");
    }
  }

  getLocalCandidates() {
    return this.connection.localCandidates.map(candidateFromIce);
  }

  getLocalParameters() {
    const params = new RTCIceParameters({
      usernameFragment: this.connection.localUserName,
      password: this.connection.localPassword,
    });

    return params;
  }

  private setState(state: IceState) {
    this._state = state;
    this.subject.execute(state);
  }
}

export function candidateFromIce(c: Candidate) {
  const candidate = new RTCIceCandidate(
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

export function candidateToIce(x: RTCIceCandidate) {
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

export type RTCIceCandidateJSON = {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
};

export class RTCIceCandidate {
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

  toJSON(): RTCIceCandidateJSON {
    return {
      candidate: candidateToSdp(this),
      sdpMLineIndex: this.sdpMLineIndex,
      sdpMid: this.sdpMid,
    };
  }

  static fromJSON(data: RTCIceCandidateJSON) {
    const candidate = candidateFromSdp(data.candidate);
    candidate.sdpMLineIndex = data.sdpMLineIndex;
    candidate.sdpMid = data.sdpMid;
    return candidate;
  }
}

export class RTCIceParameters {
  iceLite: boolean = false;
  usernameFragment?: string;
  password?: string;

  constructor(props: Partial<RTCIceParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCIceTransport {
  iceState = new Event<IceState>();
  private waitStart?: Event;
  private _state: IceState = "new";
  connection = this.gather.connection;
  roleSet = false;

  constructor(private gather: RTCIceGatherer) {
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

  get state() {
    return this._state;
  }

  private setState(state: IceState) {
    if (state !== this.state) {
      this._state = state;
      this.iceState.execute("stateChange");

      if (state === "closed") {
        this.iceGather.subject.execute();
        this.iceGather.subject.complete();
        this.iceState.execute();
        this.iceState.complete();
      }
    }
  }

  addRemoteCandidate = (candidate?: RTCIceCandidate) => {
    if (!this.connection.remoteCandidatesEnd) {
      if (!candidate) {
        this.connection.addRemoteCandidate(undefined);
      } else {
        this.connection.addRemoteCandidate(candidateToIce(candidate));
      }
    }
  };

  async start(remoteParameters: RTCIceParameters) {
    if (this.state === "closed") throw new Error("RTCIceTransport is closed");

    if (this.waitStart) await this.waitStart.asPromise();
    this.waitStart = new Event();

    this.setState("checking");
    this.connection.remoteUsername = remoteParameters.usernameFragment!;
    this.connection.remotePassword = remoteParameters.password!;

    try {
      await this.connection.connect();
      this.setState("completed");
    } catch (error) {
      this.setState("failed");
      throw new Error(error);
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
