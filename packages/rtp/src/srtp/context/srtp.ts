import { RtpHeader } from "../../rtp/rtp";
import type { SrtpProfile } from "../const";
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
    const header = RtpHeader.deSerialize(cipherText);

    const s = this.getSrtpSsrcState(header.ssrc);
    const nextState = { ...s };
    this.updateRolloverCount(header.sequenceNumber, nextState);

    const dec = this.cipher.decryptRtp(cipherText, nextState.rolloverCounter);
    Object.assign(s, nextState);
    return dec;
  }
}
