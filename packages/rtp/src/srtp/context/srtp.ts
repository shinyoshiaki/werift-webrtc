import { RtpHeader } from "../../rtp/rtp.js";
import type { SrtpProfile } from "../const.js";
import { Context } from "./context.js";

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
    const header = RtpHeader.deSerialize(cipherText);

    const s = this.getSrtpSsrcState(header.ssrc);
    this.updateRolloverCount(header.sequenceNumber, s);

    const dec = this.cipher.decryptRtp(cipherText, s.rolloverCounter);
    return dec;
  }
}
