import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCDtlsTransport } from "../transport/dtls";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTCRtpParameters,
} from "./parameters";
import * as uuid from "uuid";
import { Kind } from "../../typings/domain";

export type Direction = "sendonly" | "sendrecv" | "recvonly";

export class RTCRtpTransceiver {
  uuid = uuid.v4();
  bundled = false;
  mid?: string;
  mLineIndex?: number;
  dtlsTransport?: RTCDtlsTransport;
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  parameters: RTCRtpParameters;

  constructor(
    public kind: Kind,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    public direction: Direction
  ) {}

  onTrack = this.receiver.onTrack;

  sendRtp(rawRTP: Buffer) {
    if (!this.parameters)
      this.parameters = new RTCRtpParameters({
        muxId: this.mid,
        headerExtensions: this.headerExtensions,
      });
    this.sender.sendRtp(rawRTP, this.parameters);
  }
}
