export class RTCRtpParameters {
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  muxId = "";
  rtcp: RTCRtcpParameters;
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
}

export class RTCRtcpFeedback {
  type: string;
  parameter?: string;

  constructor(props: Partial<RTCRtcpFeedback> = {}) {
    Object.assign(this, props);
  }
}
