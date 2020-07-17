export class RTCRtpParameters {
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  muxId = "";
  rtcp: RTCRtcpParameters;
}

export class RTCRtpCodecParameters {
  mimeType: string;
  clockRate: number;
  channels?: number;
  payloadType?: number;
  rtcpFeedback: RTCRtcpFeedback[] = [];
  parameters: number[] = [];

  constructor(props: Partial<RTCRtpCodecParameters> = {}) {
    Object.assign(this, props);
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
