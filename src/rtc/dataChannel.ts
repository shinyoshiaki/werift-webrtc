class RTCDataChannelParameters {
  label = "";
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  ordered = true;
  protocol = "";
  negotiated = false;
  id?: number;
}

export class RTCDataChannel {
  id = this.parameters.id;
  constructor(
    transport: unknown,
    private parameters: RTCDataChannelParameters,
    sendOpen = true
  ) {
    if (parameters.negotiated && (!this.id || this.id < 0 || this.id > 65534))
      throw new Error(
        "ID must be in range 0-65534 if data channel is negotiated out-of-band"
      );
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
}
