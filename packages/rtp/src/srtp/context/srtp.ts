import type { RtpHeader } from "../../rtp/rtp";
import type { SrtpProfile } from "../const";
import { ProtectionProfileAeadAes128Gcm } from "../const";
import { SrtpAuthenticationError } from "../error";
import { parseSrtpRtpHeader } from "../packet";
import {
  Context,
  SrtpRolloverCounterOverflowError,
  type SrtpSsrcState,
} from "./context";

export class SrtpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: SrtpProfile) {
    super(masterKey, masterSalt, profile);
  }

  encryptRtp(payload: Buffer, header: RtpHeader) {
    const s = this.getSrtpSsrcState(header.ssrc);
    const roc = this.estimateRolloverCounter(header.sequenceNumber, s);

    const enc = this.cipher.encryptRtp(header, payload, roc);
    this.commitPacketIndex(header.sequenceNumber, roc, s);
    return enc;
  }

  decryptRtp(cipherText: Buffer): [Buffer, RtpHeader] {
    const header = parseSrtpRtpHeader(cipherText, this.rtpAuthTagLength);

    const existingState = this.srtpSSRCStates[header.ssrc];
    const state: SrtpSsrcState = existingState ?? {
      ssrc: header.ssrc,
      rolloverCounter: 0,
      lastSequenceNumber: 0,
    };
    let roc: number;
    try {
      roc = this.estimateRolloverCounter(header.sequenceNumber, state);
    } catch (error) {
      if (error instanceof SrtpRolloverCounterOverflowError) {
        throw new SrtpAuthenticationError(error.message);
      }
      throw error;
    }

    const dec = this.cipher.decryptRtp(cipherText, roc, header);
    // commit only after authentication and decryption succeeded
    if (!existingState) {
      this.srtpSSRCStates[header.ssrc] = state;
    }
    this.commitPacketIndex(header.sequenceNumber, roc, state);
    return dec;
  }

  private get rtpAuthTagLength() {
    return this.profile === ProtectionProfileAeadAes128Gcm ? 16 : 10;
  }
}
