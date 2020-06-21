import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCDtlsTransport } from "../transport/dtls";

export class RTCRtpTransceiver {
  bundled = false;
  mid?: string;
  mLineIndex?: number;
  transport?: RTCDtlsTransport;

  constructor(
    public kind: string,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    public direction: string
  ) {}
}
