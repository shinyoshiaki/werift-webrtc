export class RTCRtpParameters {
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  muxId = "";
  rtcp: RTCRtcpParameters;

  constructor(props: Partial<RTCRtpParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtpCodecCapability {
  mimeType: string;
  clockRate: number;
  channels?: number;
  parameters = {};
  constructor(parameters: Partial<RTCRtpCodecCapability> = {}) {
    Object.assign(this, parameters);
  }

  get name() {
    return this.mimeType.split("/")[1];
  }
}

export class RTCRtpCodecParameters {
  mimeType: string;
  clockRate: number;
  channels?: number;
  payloadType?: number;
  rtcpFeedback = [];
  parameters = {};

  constructor(props: Partial<RTCRtpCodecParameters> = {}) {
    Object.assign(this, props);
  }

  get name() {
    return this.mimeType.split("/")[1];
  }

  get str() {
    let s = `${this.name}/${this.clockRate}`;
    if (this.channels === 2) s += "/2";
    return s;
  }
}

export class RTCRtpHeaderExtensionParameters {
  id: number;
  uri: string;

  constructor(props: Partial<RTCRtpHeaderExtensionParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtcpParameters {
  cname?: string;
  mux: boolean = false;
  ssrc?: number;

  constructor(props: Partial<RTCRtcpParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtcpFeedback {
  type: string;
  parameter?: string;

  constructor(props: Partial<RTCRtcpFeedback> = {}) {
    Object.assign(this, props);
  }
}
export class RTCRtpRtxParameters {
  ssrc: number;

  constructor(props: Partial<RTCRtpRtxParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtpCodingParameters {
  ssrc: number;
  payloadType: number;
  rtx?: RTCRtpRtxParameters;

  constructor(props: Partial<RTCRtpCodingParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtpReceiveParameters extends RTCRtpParameters {
  encodings: RTCRtpCodingParameters[];

  constructor(props: Partial<RTCRtpReceiveParameters> = {}) {
    super(props);
    Object.assign(this, props);
  }
}
