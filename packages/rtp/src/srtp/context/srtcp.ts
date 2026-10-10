import type { RtcpHeader } from "../../rtcp/header";
import { ProtectionProfileAeadAes128Gcm, type SrtpProfile } from "../const";
import { SrtpReplayError } from "../error";
import { SrtpReplayWindow } from "../replay";
import { Context } from "./context";

export class SrtcpContext extends Context {
  /** Receive-side replay windows (RFC 3711 §3.3.2), per SSRC. */
  private readonly rtcpReplayWindows: { [ssrc: number]: SrtpReplayWindow } = {};

  constructor(masterKey: Buffer, masterSalt: Buffer, profile: SrtpProfile) {
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
    // RFC 3711 §3.3.2: the E-flag + 31-bit SRTCP index trails the packet
    // (before the auth tag for AES-CM, after the AEAD tag for AES-GCM).
    const indexOffset =
      this.profile === ProtectionProfileAeadAes128Gcm
        ? encrypted.length - srtcpIndexSize
        : encrypted.length - srtcpAuthTagLength - srtcpIndexSize;
    if (indexOffset < 8) {
      // Too short to carry an index; let the cipher report it.
      return this.cipher.decryptRTCP(encrypted);
    }
    const ssrc = encrypted.readUInt32BE(4);
    const index = encrypted.readUInt32BE(indexOffset) & maxSRTCPIndex;
    const replay = (this.rtcpReplayWindows[ssrc] ??= new SrtpReplayWindow());
    if (!replay.check(index)) {
      throw new SrtpReplayError(
        `SRTCP replay rejected (ssrc=${ssrc} index=${index})`,
      );
    }
    const dec = this.cipher.decryptRTCP(encrypted);
    replay.accept(index);
    return dec;
  }
}

const maxSRTCPIndex = 0x7fffffff;
const srtcpIndexSize = 4;
/** HMAC-SHA1-80 tag length of the AES-CM SRTCP profile. */
const srtcpAuthTagLength = 10;
