import { Event, debug } from "./imports/common.js";

import { EventTarget } from "./helper.js";
import type { RTCSctpTransport } from "./transport/sctp.js";
import type { Callback, CallbackWithValue } from "./types/util.js";

const log = debug("werift:packages/webrtc/src/dataChannel.ts");

export interface DataChannelStats {
  messagesSent: number;
  bytesSent: number;
  messagesReceived: number;
  bytesReceived: number;
}

export class RTCDataChannel extends EventTarget implements DataChannelStats {
  readonly stateChange = new Event<[DCState]>();
  readonly stateChanged = new Event<[DCState]>();
  readonly onOpen = new Event();
  readonly onMessage = new Event<[string | Buffer]>();
  // todo impl
  readonly error = new Event<[Error]>();
  readonly bufferedAmountLow = new Event();
  onopen?: Callback;
  onclose?: Callback;
  onclosing?: Callback;
  onmessage?: CallbackWithValue<MessageEvent>;
  // todo impl
  onerror?: CallbackWithValue<RTCErrorEvent>;
  isCreatedByRemote = false;
  id: number;
  readyState: DCState = "connecting";

  bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;

  // Statistics
  messagesSent = 0;
  bytesSent = 0;
  messagesReceived = 0;
  bytesReceived = 0;

  constructor(
    readonly sctp: RTCSctpTransport,
    private readonly parameters: RTCDataChannelParameters,
    public readonly sendOpen = true,
  ) {
    super();

    this.id = this.parameters.id;

    if (parameters.negotiated) {
      if (this.id == undefined || this.id < 0 || this.id > 65534) {
        throw new Error(
          "ID must be in range 0-65534 if data channel is negotiated out-of-band",
        );
      }
      this.sctp.dataChannelAddNegotiated(this);
    } else {
      if (sendOpen) {
        this.sendOpen = false;
        this.sctp.dataChannelOpen(this);
      }
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
    if (value < 0 || value > 4294967295) {
      throw new Error(
        "bufferedAmountLowThreshold must be in range 0 - 4294967295",
      );
    }
    this._bufferedAmountLowThreshold = value;
  }

  setId(id: number) {
    this.id = id;
  }

  setReadyState(state: DCState) {
    if (state !== this.readyState) {
      this.readyState = state;
      this.stateChange.execute(state);
      this.stateChanged.execute(state);

      switch (state) {
        case "open":
          if (this.onopen) this.onopen();
          this.emit("open");
          this.onOpen.execute();
          break;
        case "closed":
          if (this.onclose) this.onclose();
          this.emit("close");
          break;
        case "closing":
          if (this.onclosing) this.onclosing();
          break;
      }
      log("change state", state);
    }
  }

  addBufferedAmount(amount: number) {
    const crossesThreshold =
      this.bufferedAmount > this.bufferedAmountLowThreshold &&
      this.bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this.bufferedAmount += amount;
    if (crossesThreshold) {
      this.bufferedAmountLow.execute();
      this.emit("bufferedamountlow");
    }
  }

  send(data: Buffer | string) {
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    this.messagesSent++;
    this.bytesSent += size;
    this.sctp.datachannelSend(this, data);
  }

  close() {
    this.sctp.dataChannelClose(this);
  }
}

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

export interface MessageEvent {
  data: string | Buffer;
}

export interface RTCErrorEvent {
  error: any;
}
