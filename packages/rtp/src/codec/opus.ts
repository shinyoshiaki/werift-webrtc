import { RtpHeader } from "../rtp/rtp";
import { DePacketizerBase } from "./base";

export class OpusRtpPayload implements DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const opus = new OpusRtpPayload();
    opus.payload = buf;
    return opus;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return true;
  }

  get isKeyframe() {
    return true;
  }
}
