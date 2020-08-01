import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpSender } from "./rtpSender";
import { RTCDtlsTransport } from "../transport/dtls";
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "./parameters";
import * as uuid from "uuid";
import { Kind } from "../../typings/domain";

export type Direction = "sendonly" | "sendrecv" | "recvonly";

export class RTCRtpTransceiver {
  uuid = uuid.v4();
  bundled = false;
  mid?: string;
  mLineIndex?: number;
  transport?: RTCDtlsTransport;
  codecs: RTCRtpCodecParameters[] = [];
  headerExtensions: RTCRtpHeaderExtensionParameters[] = [];
  currentDirection?: Direction;
  offerDirection?: Direction;

  constructor(
    public kind: Kind,
    public receiver: RTCRtpReceiver,
    public sender: RTCRtpSender,
    public direction: Direction
  ) {}

  stop() {}
}
