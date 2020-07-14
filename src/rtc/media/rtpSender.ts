import { randomBytes } from "crypto";
import { jspack } from "jspack";
import { RTCDtlsTransport } from "../transport/dtls";
import * as uuid from "uuid";

export class RTCRtpSender {
  ssrc = jspack.Unpack("!L", randomBytes(4))[0];
  streamId = uuid.v4();

  constructor(public trackOrKind: string | any, transport: RTCDtlsTransport) {}
}
