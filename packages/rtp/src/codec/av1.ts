// RTP Payload Format For AV1

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

    let index = 0;

    c.z = getBit(buf[index], 0);
    c.y = getBit(buf[index], 1);
    c.w = getBit(buf[index], 2, 2);
    c.n = getBit(buf[index], 4);

    index++;

    return c;
  }

  get isKeyframe() {
    return this.n === 1;
  }
}
