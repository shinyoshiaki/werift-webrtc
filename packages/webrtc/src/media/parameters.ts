import { Direction } from "./rtpTransceiver";

export interface RTCRtpParameters {
  codecs: RTCRtpCodecParameters[];
  headerExtensions: RTCRtpHeaderExtensionParameters[];
  muxId?: string;
  rtpStreamId?: string;
  repairedRtpStreamId?: string;
  rtcp?: RTCRtcpParameters;
}

export type RTCPFB = { type: string; parameter?: string };

export class RTCRtpCodecParameters {
  /**
   * When specifying a codec with a fixed payloadType such as PCMU,
   * it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.
   */
  payloadType!: number;
  mimeType!: string;
  clockRate!: number;
  channels?: number;
  rtcpFeedback: RTCPFB[] = [];
  parameters?: string;
  direction: Direction | "all" = "all";

  constructor(
    props: Pick<RTCRtpCodecParameters, "mimeType" | "clockRate"> &
      Partial<RTCRtpCodecParameters>
  ) {
    Object.assign(this, props);
  }

  get name() {
    return this.mimeType.split("/")[1];
  }

  get contentType() {
    return this.mimeType.split("/")[0];
  }

  get str() {
    let s = `${this.name}/${this.clockRate}`;
    if (this.channels === 2) s += "/2";
    return s;
  }
}

export class RTCRtpHeaderExtensionParameters {
  id!: number;
  uri!: string;

  constructor(
    props: Partial<RTCRtpHeaderExtensionParameters> &
      Pick<RTCRtpHeaderExtensionParameters, "uri">
  ) {
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
  type!: string;
  parameter?: string;

  constructor(props: Partial<RTCRtcpFeedback> = {}) {
    Object.assign(this, props);
  }
}
export class RTCRtpRtxParameters {
  ssrc!: number;

  constructor(props: Partial<RTCRtpRtxParameters> = {}) {
    Object.assign(this, props);
  }
}

export class RTCRtpCodingParameters {
  ssrc!: number;
  payloadType!: number;
  rtx?: RTCRtpRtxParameters;

  constructor(
    props: Partial<RTCRtpCodingParameters> &
      Pick<RTCRtpCodingParameters, "ssrc" | "payloadType">
  ) {
    Object.assign(this, props);
  }
}

export interface RTCRtpReceiveParameters extends RTCRtpParameters {
  encodings: RTCRtpCodingParameters[];
}

export interface RTCRtpSendParameters extends RTCRtpParameters {}

export class RTCRtpSimulcastParameters {
  rid!: string;
  direction!: "send" | "recv";
  constructor(props: RTCRtpSimulcastParameters) {
    Object.assign(this, props);
  }
}
