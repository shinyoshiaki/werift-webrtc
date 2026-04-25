import type { RtpHeader } from "../../rtp/rtp";
import { ProtectionProfileAeadAes128Gcm } from "../const";
import type { SrtpProfile } from "../const";
import { parseSrtpRtpHeader } from "../packet";
import { Context } from "./context";

export class SrtpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: SrtpProfile) {
    super(masterKey, masterSalt, profile);
  }

  encryptRtp(payload: Buffer, header: RtpHeader) {
    const s = this.getSrtpSsrcState(header.ssrc);
    this.updateRolloverCount(header.sequenceNumber, s);

    const enc = this.cipher.encryptRtp(header, payload, s.rolloverCounter);
    return enc;
  }

  decryptRtp(cipherText: Buffer): [Buffer, RtpHeader] {
    const header = parseSrtpRtpHeader(cipherText, this.rtpAuthTagLength);

    const existingState = this.srtpSSRCStates[header.ssrc];
    const nextState = existingState
      ? { ...existingState }
      : {
          ssrc: header.ssrc,
          rolloverCounter: 0,
          lastSequenceNumber: 0,
        };
    this.updateRolloverCount(header.sequenceNumber, nextState);

    const dec = this.cipher.decryptRtp(
      cipherText,
      nextState.rolloverCounter,
      header,
    );
    if (existingState) {
      Object.assign(existingState, nextState);
    } else {
      this.srtpSSRCStates[header.ssrc] = nextState;
    }
    return dec;
  }

  private get rtpAuthTagLength() {
    return this.profile === ProtectionProfileAeadAes128Gcm ? 16 : 10;
  }
}
