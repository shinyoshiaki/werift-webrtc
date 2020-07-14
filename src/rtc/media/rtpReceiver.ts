import { RTCDtlsTransport } from "../transport/dtls";
import { RemoteStreamTrack } from "./mediastream";

export class RTCRtpReceiver {
  private rtcpSsrc?: number;
  track?: RemoteStreamTrack;

  constructor(public kind: string, public transport: RTCDtlsTransport) {}

  setRtcpSsrc(ssrc: number) {
    this.rtcpSsrc = ssrc;
  }
}
