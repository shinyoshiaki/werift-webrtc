import { RtcpHeader } from "../../rtcp/header";
import { Profile } from "../const";
import { Context } from "./context";

export class SrtcpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: Profile) {
    super(masterKey, masterSalt, profile);
  }

  encryptRTCP(rawRtcp: Buffer) {
    const ssrc = rawRtcp.readUInt32BE(4);
    const s = this.getSrtcpSsrcState(ssrc);
    s.srtcpIndex++;
    if (s.srtcpIndex >> maxSRTCPIndex) {
      s.srtcpIndex = 0;
    }
    const enc = this.cipher.encryptRTCP(rawRtcp, s.srtcpIndex);
    return enc;
  }

  decryptRTCP(encrypted: Buffer): [Buffer, RtcpHeader] {
    const dec = this.cipher.decryptRTCP(encrypted);
    return dec;
  }
}

const maxSRTCPIndex = 0x7fffffff;
