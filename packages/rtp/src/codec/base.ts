import { RtpHeader } from "../rtp/rtp";

export abstract class DePacketizerBase {
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    return {} as unknown as DePacketizerBase;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return true as boolean;
  }

  get isKeyframe() {
    return true as boolean;
  }
}
