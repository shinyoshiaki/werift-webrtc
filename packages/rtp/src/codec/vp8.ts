import { getBit, paddingByte } from "../../../common/src";
import { RtpHeader } from "../rtp/rtp";
import { DePacketizerBase } from "./base";

// RFC 7741 - RTP Payload Format for VP8 Video

//        0 1 2 3 4 5 6 7                      0 1 2 3 4 5 6 7
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//       |X|R|N|S|R| PID | (REQUIRED)        |X|R|N|S|R| PID | (REQUIRED)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  X:   |I|L|T|K| RSV   | (OPTIONAL)   X:   |I|L|T|K| RSV   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  I:   |M| PictureID   | (OPTIONAL)   I:   |M| PictureID   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  L:   |   TL0PICIDX   | (OPTIONAL)        |   PictureID   |
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//  T/K: |TID|Y| KEYIDX  | (OPTIONAL)   L:   |   TL0PICIDX   | (OPTIONAL)
//       +-+-+-+-+-+-+-+-+                   +-+-+-+-+-+-+-+-+
//                                      T/K: |TID|Y| KEYIDX  | (OPTIONAL)
//                                           +-+-+-+-+-+-+-+-+

// 0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Size0|H| VER |P|
// +-+-+-+-+-+-+-+-+
// |     Size1     |
// +-+-+-+-+-+-+-+-+
// |     Size2     |
// +-+-+-+-+-+-+-+-+
// | Octets 4..N of|
// | VP8 payload   |
// :               :
// +-+-+-+-+-+-+-+-+
// | OPTIONAL RTP  |
// | padding       |
// :               :
// +-+-+-+-+-+-+-+-+

export class Vp8RtpPayload implements DePacketizerBase {
  xBit!: number;
  nBit!: number;
  sBit!: number;
  pid!: number;
  iBit?: number;
  lBit?: number;
  tBit?: number;
  kBit?: number;
  mBit?: number;
  pictureId?: number;
  payload!: Buffer;
  size0 = 0;
  hBit?: number;
  ver?: number;
  pBit?: number;
  size1 = 0;
  size2 = 0;

  static deSerialize(buf: Buffer) {
    const p = new Vp8RtpPayload();

    let offset = 0;

    p.xBit = getBit(buf[offset], 0);
    p.nBit = getBit(buf[offset], 2);
    p.sBit = getBit(buf[offset], 3);
    p.pid = getBit(buf[offset], 5, 3);
    offset++;

    if (p.xBit) {
      p.iBit = getBit(buf[offset], 0);
      p.lBit = getBit(buf[offset], 1);
      p.tBit = getBit(buf[offset], 2);
      p.kBit = getBit(buf[offset], 3);
      offset++;
    }

    if (p.iBit) {
      p.mBit = getBit(buf[offset], 0);
      if (p.mBit) {
        const _7 = paddingByte(getBit(buf[offset], 1, 7));
        const _8 = paddingByte(buf[offset + 1]);
        p.pictureId = parseInt(_7 + _8, 2);
        offset += 2;
      } else {
        p.pictureId = getBit(buf[offset], 1, 7);
        offset++;
      }
    }

    if (p.lBit) {
      offset++;
    }

    if (p.lBit || p.kBit) {
      if (p.tBit) {
      }
      if (p.kBit) {
      }
      offset++;
    }

    p.payload = buf.subarray(offset);

    if (p.payloadHeaderExist) {
      p.size0 = getBit(buf[offset], 0, 3);
      p.hBit = getBit(buf[offset], 3);
      p.ver = getBit(buf[offset], 4, 3);
      p.pBit = getBit(buf[offset], 7);
      offset++;
      p.size1 = buf[offset];
      offset++;
      p.size2 = buf[offset];
    }

    return p;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return this.pBit === 0;
  }

  get isPartitionHead() {
    return this.sBit === 1;
  }

  get payloadHeaderExist() {
    return this.sBit === 1 && this.pid === 0;
  }

  get size() {
    if (this.payloadHeaderExist) {
      const size = this.size0 + 8 * this.size1 + 2048 * this.size2;
      return size;
    }
    return 0;
  }
}
