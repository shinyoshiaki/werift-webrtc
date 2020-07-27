import { createCipheriv, createDecipheriv } from "crypto";
import { Context } from "./context";
import { RtcpHeader } from "../../rtcp/header";

export class SrtcpContext extends Context {
  constructor(masterKey: Buffer, masterSalt: Buffer, profile: number) {
    super(masterKey, masterSalt, profile);
  }
  decryptRTCP(encrypted: Buffer): [Buffer, RtcpHeader] {
    const header = RtcpHeader.deSerialize(encrypted);

    const tailOffset = encrypted.length - (10 + 4);
    const out = Buffer.from(encrypted).slice(0, tailOffset);

    const isEncrypted = encrypted[tailOffset] >> 7;
    if (isEncrypted === 0) return [out, header];

    let index = encrypted.readUInt32BE(tailOffset);
    index &= ~(1 << 31);

    const ssrc = encrypted.readUInt32BE(4);

    const actualTag = encrypted.slice(encrypted.length - 10);

    const counter = this.generateCounter(
      index & 0xffff,
      index >> 16,
      ssrc,
      this.srtcpSessionSalt
    );
    const cipher = createDecipheriv(
      "aes-128-ctr",
      this.srtcpSessionKey,
      counter
    );
    const buf = cipher.update(out.slice(8));
    buf.copy(out, 8);
    return [out, header];
  }

  encryptRTCP(decrypted: Buffer): Buffer {
    let out = Buffer.from(decrypted);
    const ssrc = out.readUInt32BE(4);
    const s = this.getSRTCPSSRCState(ssrc);
    s.srtcpIndex++;
    if (s.srtcpIndex >> 0x7fffffff) {
      s.srtcpIndex = 0;
    }

    const counter = this.generateCounter(
      s.srtcpIndex & 0xffff,
      s.srtcpIndex >> 16,
      ssrc,
      this.srtcpSessionSalt
    );
    const cipher = createCipheriv("aes-128-ctr", this.srtcpSessionKey, counter);
    // Encrypt everything after header
    const buf = cipher.update(out.slice(8));
    buf.copy(out, 8);
    out = Buffer.concat([out, Buffer.alloc(4)]);
    out.writeUInt32BE(s.srtcpIndex, out.length - 4);
    out[out.length - 4] |= 0x80;
    const authTag = this.generateSrtcpAuthTag(out);
    out = Buffer.concat([out, authTag]);

    return out;
  }
}
