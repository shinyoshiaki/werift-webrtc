import { Event } from "rx.mini";
import { RTCSctpTransport } from "./transport/sctp";

export type DCState = "open" | "closed" | "connecting" | "closing";

export class RTCDataChannelParameters {
  label = "";
  maxPacketLifeTime?: number; // sec
  maxRetransmits?: number;
  ordered = true;
  protocol = "";
  negotiated = false;
  id!: number;
  constructor(props: Partial<RTCDataChannelParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCDataChannel {
  readonly stateChanged = new Event<[DCState]>();
  readonly message = new Event<[string | Buffer]>();
  readonly bufferedAmountLow = new Event();
  isCreatedByRemote = false;
  id: number = this.parameters.id;
  readyState: DCState = "connecting";

  private bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;
  constructor(
    private readonly transport: RTCSctpTransport,
    private readonly parameters: RTCDataChannelParameters,
    public readonly sendOpen = true
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

  setReadyState(state: DCState) {
    if (state !== this.readyState) {
      this.readyState = state;
      this.stateChanged.execute(state);
    }
  }

  addBufferedAmount(amount: number) {
    const crossesThreshold =
      this.bufferedAmount > this.bufferedAmountLowThreshold &&
      this.bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this.bufferedAmount += amount;
    if (crossesThreshold) {
      this.bufferedAmountLow.execute();
    }
  }

  async send(data: Buffer | string) {
    if (this.readyState !== "open") return;
    await this.transport.datachannelSend(this, data);
  }

  close() {
    this.transport.dataChannelClose(this);
  }
}
