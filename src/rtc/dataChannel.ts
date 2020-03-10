import { RTCSctpTransport } from "./transport/sctp";
import { Subject } from "rxjs";

export class RTCDataChannelParameters {
  label = "";
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  ordered = true;
  protocol = "";
  negotiated = false;
  id?: number;
  constructor() {}
}

export class RTCDataChannel {
  subject = new Subject<string>();
  id = this.parameters.id || 0;
  readyState = "connecting";
  constructor(
    private transport: RTCSctpTransport,
    private parameters: RTCDataChannelParameters,
    public sendOpen = true
  ) {
    if (parameters.negotiated && (!this.id || this.id < 0 || this.id > 65534))
      throw new Error(
        "ID must be in range 0-65534 if data channel is negotiated out-of-band"
      );

    if (!parameters.negotiated) {
      if (sendOpen) {
        this.sendOpen = false;
        this.transport.dataChannelOpen(this);
      }
    } else {
      this.transport.dataChannelAddNegotiated(this);
    }
  }

  get ordered() {
    return this.parameters.ordered;
  }

  get maxRetransmits() {
    return this.parameters.maxRetransmits;
  }

  get maxPacketLifeTime() {
    return this.parameters.maxPacketLifeTime;
  }

  get label() {
    return this.parameters.label;
  }

  get protocol() {
    return this.parameters.protocol;
  }

  setReadyState(state: string) {
    if (state !== this.readyState) {
      this.readyState = state;
      this.subject.next(state);
    }
  }
}
