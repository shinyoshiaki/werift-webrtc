import { assignClassProperties } from "../utils";

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
}

export class RTCRtpHeaderExtensionParameters {
  id: number;
  uri: string;
}

export class RTCRtcpParameters {
  cname?: string;
  mux: boolean = false;
  ssrc?: number;
}

export class RTCRtcpFeedback {
  type: string;
  parameter?: string;

  constructor(props: Partial<RTCRtcpFeedback>) {
    assignClassProperties(this, props);
  }
}
