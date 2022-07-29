import debug from 'debug';
import { Event } from 'rx.mini';

import { EventTarget } from './helper';
import { RTCSctpTransport } from './transport/sctp';
import { Callback, CallbackWithValue } from './types/util';

const log = debug('werift/webrtc/datachannel');

export class RTCDataChannel extends EventTarget {
  readonly stateChanged = new Event<[DCState]>();
  readonly message = new Event<[string | Buffer]>();
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
  id: number = this.parameters.id;
  readyState: DCState = 'connecting';

  bufferedAmount = 0;
  private _bufferedAmountLowThreshold = 0;

  constructor(
    private readonly transport: RTCSctpTransport,
    private readonly parameters: RTCDataChannelParameters,
    public readonly sendOpen = true
  ) {
    super();

    if (parameters.negotiated) {
      if (this.id == undefined || this.id < 0 || this.id > 65534) {
        throw new Error('ID must be in range 0-65534 if data channel is negotiated out-of-band');
      }
      this.transport.dataChannelAddNegotiated(this);
    } else {
      if (sendOpen) {
        this.sendOpen = false;
        this.transport.dataChannelOpen(this);
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
      throw new Error('bufferedAmountLowThreshold must be in range 0 - 4294967295');
    }
    this._bufferedAmountLowThreshold = value;
  }

  setId(id: number) {
    this.id = id;
  }

  setReadyState(state: DCState) {
    if (state !== this.readyState) {
      this.readyState = state;
      this.stateChanged.execute(state);

      switch (state) {
        case 'open':
          if (this.onopen) this.onopen();
          this.emit('open');
          break;
        case 'closed':
          if (this.onclose) this.onclose();
          this.emit('close');
          break;
        case 'closing':
          if (this.onclosing) this.onclosing();
          break;
      }
      log('change state', state);
    }
  }

  addBufferedAmount(amount: number) {
    const crossesThreshold =
      this.bufferedAmount > this.bufferedAmountLowThreshold &&
      this.bufferedAmount + amount <= this.bufferedAmountLowThreshold;
    this.bufferedAmount += amount;
    if (crossesThreshold) {
      this.bufferedAmountLow.execute();
      this.emit('bufferedamountlow');
    }
  }

  send(data: Buffer | string) {
    this.transport.datachannelSend(this, data);
  }

  close() {
    this.transport.dataChannelClose(this);
  }
}

export type DCState = 'open' | 'closed' | 'connecting' | 'closing';

export class RTCDataChannelParameters {
  label = '';
  maxPacketLifeTime?: number; // sec
  maxRetransmits?: number;
  ordered = true;
  protocol = '';
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
