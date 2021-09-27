// RTP Payload Format For AV1 https://aomediacodec.github.io/av1-rtp-spec/

import { getBit } from "../../../common/src";
import { DePacketizerBase, RtpHeader } from "..";

// 4.4 AV1 Aggregation Header
//  0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Z|Y| W |N|-|-|-|
// +-+-+-+-+-+-+-+-+

export class AV1RtpPayload implements DePacketizerBase {
  /**RtpStartsWithFragment */
  zBit!: number;
  /**RtpEndsWithFragment */
  yBit!: number;
  /**RtpNumObus */
  w!: number;
  /**RtpStartsNewCodedVideoSequence */
  nBit!: number;
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const p = new AV1RtpPayload();

    let offset = 0;

    p.zBit = getBit(buf[offset], 0);
    p.yBit = getBit(buf[offset], 1);
    p.w = getBit(buf[offset], 2, 2);
    p.nBit = getBit(buf[offset], 4);

    offset++;

    if (p.nBit && p.zBit) {
      p.payload = Buffer.alloc(0);
    } else {
      p.payload = buf;
    }

    return p;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return this.nBit === 1;
  }
}
