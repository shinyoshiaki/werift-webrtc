import { RtpHeader } from "../../rtp/rtp";
import { Profile } from "../const";
import { Context } from "./context";

export class SrtpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: Profile) {
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
