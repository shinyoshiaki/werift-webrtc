import type { MediaDirection } from "./rtpTransceiver";

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
  direction: MediaDirection | "all" = "all";

  constructor(
    props: Pick<RTCRtpCodecParameters, "mimeType" | "clockRate"> &
      Partial<RTCRtpCodecParameters>,
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
      Pick<RTCRtpHeaderExtensionParameters, "uri">,
  ) {
    Object.assign(this, props);
  }
}

export class RTCRtcpParameters {
  cname?: string;
  mux = false;
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
      Pick<RTCRtpCodingParameters, "ssrc" | "payloadType">,
  ) {
    Object.assign(this, props);
  }
}

export interface RTCRtpReceiveParameters extends RTCRtpParameters {
  encodings: RTCRtpCodingParameters[];
  /**
   * `a=ssrc-group:FID` pairs of an m-line the remote sends by RID: they route
   * the RTX SSRC only, tracks come from the RIDs
   * (tests/media/firefoxSimulcastSsrc.test.ts "Firefox の offer を受けても、トラックは RID ごとの 1 本だけで、両レイヤーの RTX は RID のトラックへ復元される").
   * @internal
   */
  ridRtxPairs?: { ssrc: number; rtxSsrc: number }[];
}

export type RTCRtpSendParameters = RTCRtpParameters;

export class RTCRtpSimulcastParameters {
  rid!: string;
  direction!: "send" | "recv";
  /**
   * `a=rid` restrictions after the direction, RFC 8851
   * (tests/sdp.test.ts "a=rid の方向と制約を分けて読み、書き戻すと元の行になる").
   */
  restrictions?: string;
  constructor(props: RTCRtpSimulcastParameters) {
    Object.assign(this, props);
  }
}
