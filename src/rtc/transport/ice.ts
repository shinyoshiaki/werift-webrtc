import { Connection, Candidate } from "../../vendor/icet";
import { Subject } from "rxjs";

type IceState =
  | "new"
  | "gathering"
  | "stateChange"
  | "completed"
  | "closed"
  | "checking"
  | "failed";

export class RTCIceGatherer {
  subject = new Subject<IceState>();
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
      await this.connection.gatherCandidates();
      this.setState("completed");
    }
  }

  getLocalCandidates() {
    return this.connection.localCandidates.map(candidateFromIce);
  }

  getLocalParameters() {
    const params = new RTCIceParameters();
    params.usernameFragment = this.connection.localUserName;
    params.password = this.connection.localPassword;
    return params;
  }

  private setState(state: IceState) {
    this._state = state;
    this.subject.next(state);
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

export class RTCIceCandidate {
  // """
  // The :class:`RTCIceCandidate` interface represents a candidate Interactive
  // Connectivity Establishment (ICE) configuration which may be used to
  // establish an RTCPeerConnection.
  // """
  public relatedAddress?: string;
  public relatedPort?: number;
  public sdpMid?: unknown;
  public sdpMLineIndex?: unknown;
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
}

export class RTCIceParameters {
  public usernameFragment?: string;
  public password?: string;
}

export class RTCIceTransport {
  subject = new Subject<IceState>();
  private _start?: Subject<unknown>;
  private _state: IceState = "new";
  connection = this.gather.connection;

  constructor(private gather: RTCIceGatherer) {}

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
      this.subject.next("stateChange");

      if (state === "closed") {
        this.iceGather.subject.complete();
        this.subject.complete();
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

    this._start = new Subject();

    this.setState("checking");
    this.connection.remoteUsername = remoteParameters.usernameFragment!;
    this.connection.remotePassword = remoteParameters.password!;

    try {
      await this.connection.connect();
      this.setState("completed");
    } catch (error) {
      this.setState("failed");
    }

    this._start.next();
  }

  async stop() {
    if (this.state !== "closed") {
      this.setState("closed");
      await this.connection.close();
    }
  }
}
