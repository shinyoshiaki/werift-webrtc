import { RTCDtlsTransport } from "../transport/dtls";

export class RTCRtpReceiver {
  private rtcpSsrc?: number;

  constructor(public kind: string, public transport: RTCDtlsTransport) {}

  setRtcpSsrc(ssrc: number) {
    this.rtcpSsrc = ssrc;
  }
}
