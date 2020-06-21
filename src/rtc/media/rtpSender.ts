import { randomBytes } from "crypto";
import { jspack } from "jspack";
import { RTCDtlsTransport } from "../transport/dtls";

export class RTCRtpSender {
  ssrc: number = jspack.Unpack("!L", randomBytes(4))[0];
  streamId?: string;

  constructor(public trackOrKind: string | any, transport: RTCDtlsTransport) {}
}
