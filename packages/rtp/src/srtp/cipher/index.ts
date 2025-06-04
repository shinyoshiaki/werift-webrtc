import type { RtcpHeader } from "../../rtcp/header.js";
import type { RtpHeader } from "../../rtp/rtp.js";

export abstract class CipherAesBase {
  constructor(
    public srtpSessionKey: Buffer,
    public srtpSessionSalt: Buffer,
    public srtcpSessionKey: Buffer,
    public srtcpSessionSalt: Buffer,
  ) {}

  encryptRtp(
    header: RtpHeader,
    payload: Buffer,
    rolloverCounter: number,
  ): Buffer {
    return Buffer.from([]);
  }

  decryptRtp(cipherText: Buffer, rolloverCounter: number): [Buffer, RtpHeader] {
    return [] as any;
  }

  encryptRTCP(rawRtcp: Buffer, srtcpIndex: number): Buffer {
    return Buffer.from([]);
  }

  decryptRTCP(encrypted: Buffer): [Buffer, RtcpHeader] {
    return [] as any;
  }
}
