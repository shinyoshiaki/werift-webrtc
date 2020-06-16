import { RTCSctpTransport } from "./transport/sctp";
import { Subject } from "rxjs";

export class RTCDataChannelParameters {
  label = "";
  maxPacketLifeTime?: number; // sec
  maxRetransmits?: number;
  ordered = true;
  protocol = "";
  negotiated = false;
  id?: number;
  constructor(props: Partial<RTCDataChannelParameters> = {}) {
    Object.keys(props as any).forEach((key: string) => {
      (this as any)[key] = (props as any)[key];
    });
  }
}

export class RTCDataChannel {
  state = new Subject<string>();
  message = new Subject<string | Buffer>();
  bufferedAmountLow = new Subject();
  id?: number = this.parameters.id;
  readyState = "connecting";
  private bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;
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

  get negotiated() {
    return this.parameters.negotiated;
  }

  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value: number) {
    if (value < 0 || value > 4294967295)
      throw new Error(
        "bufferedAmountLowThreshold must be in range 0 - 4294967295"
      );
    this.bufferedAmountLowThreshold = value;
  }

  setId(id: number) {
    this.id = id;
  }

  setReadyState(state: string) {
    if (state !== this.readyState) {
      this.readyState = state;
      this.state.next(state);
    }
  }

  addBufferedAmount(amount: number) {
    const crossesThreshold =
      this.bufferedAmount > this.bufferedAmountLowThreshold &&
      this.bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this.bufferedAmount += amount;
    if (crossesThreshold) {
      this.bufferedAmountLow.next();
    }
  }

  send(data: Buffer) {
    if (this.readyState !== "open") throw new Error();
    this.transport.datachannelSend(this, data);
  }
}
