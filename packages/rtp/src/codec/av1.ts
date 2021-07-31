// RTP Payload Format For AV1 https://aomediacodec.github.io/av1-rtp-spec/

import { getBit } from "../../../common/src";

//  0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Z|Y| W |N|-|-|-|
// +-+-+-+-+-+-+-+-+

export class AV1RtpPayload {
  z!: number;
  y!: number;
  w!: number;
  n!: number;

  static deSerialize(buf: Buffer) {
    const c = new AV1RtpPayload();

    let offset = 0;

    c.z = getBit(buf[offset], 0);
    c.y = getBit(buf[offset], 1);
    c.w = getBit(buf[offset], 2, 2);
    c.n = getBit(buf[offset], 4);

    offset++;

    return c;
  }

  get isKeyframe() {
    return this.n === 1;
  }
}
