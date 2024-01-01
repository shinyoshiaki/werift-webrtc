import { bufferWriter, bufferWriterLE } from "../../../common/src";
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

  static createCodecPrivate(samplingFrequency = 48000) {
    return Buffer.concat([
      Buffer.from("OpusHead"),
      bufferWriter([1, 1], [1, 2]),
      bufferWriterLE([2, 4, 2, 1], [312, samplingFrequency, 0, 0]),
    ]);
  }
}
