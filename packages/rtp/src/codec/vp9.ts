// RTP Payload Format for VP9 Video draft-ietf-payload-vp9-16 https://datatracker.ietf.org/doc/html/draft-ietf-payload-vp9

import { getBit, paddingByte } from "../../../common/src";

//          0 1 2 3 4 5 6 7
//         +-+-+-+-+-+-+-+-+
//         |I|P|L|F|B|E|V|Z| (REQUIRED)
//         +-+-+-+-+-+-+-+-+
//    I:   |M| PICTURE ID  | (REQUIRED)
//         +-+-+-+-+-+-+-+-+
//    M:   | EXTENDED PID  | (RECOMMENDED)
//         +-+-+-+-+-+-+-+-+
//    L:   | TID |U| SID |D| (Conditionally RECOMMENDED)
//         +-+-+-+-+-+-+-+-+                             -\
//    P,F: | P_DIFF      |N| (Conditionally REQUIRED)    - up to 3 times
//         +-+-+-+-+-+-+-+-+                             -/
//    V:   | SS            |
//         | ..            |
//         +-+-+-+-+-+-+-+-+

//          0 1 2 3 4 5 6 7
//         +-+-+-+-+-+-+-+-+
//         |I|P|L|F|B|E|V|Z| (REQUIRED)
//         +-+-+-+-+-+-+-+-+
//    I:   |M| PICTURE ID  | (RECOMMENDED)
//         +-+-+-+-+-+-+-+-+
//    M:   | EXTENDED PID  | (RECOMMENDED)
//         +-+-+-+-+-+-+-+-+
//    L:   | TID |U| SID |D| (Conditionally RECOMMENDED)
//         +-+-+-+-+-+-+-+-+
//         |   TL0PICIDX   | (Conditionally REQUIRED)
//         +-+-+-+-+-+-+-+-+
//    V:   | SS            |
//         | ..            |
//         +-+-+-+-+-+-+-+-+

export class Vp9RtpPayload {
  i!: number;
  p!: number;
  l!: number;
  f!: number;
  b!: number;
  e!: number;
  v!: number;
  z!: number;
  m?: number;
  pictureId?: number;
  tid?: number;
  u?: number;
  sid?: number;
  d?: number;

  static deSerialize(buf: Buffer) {
    const c = new Vp9RtpPayload();

    let index = 0;

    c.i = getBit(buf[index], 0);
    c.p = getBit(buf[index], 1);
    c.l = getBit(buf[index], 2);
    c.f = getBit(buf[index], 3);
    c.b = getBit(buf[index], 4);
    c.e = getBit(buf[index], 5);
    c.v = getBit(buf[index], 6);
    c.z = getBit(buf[index], 7);

    index++;

    if (c.i === 1) {
      c.m = getBit(buf[index], 0);

      if (c.m === 1) {
        const _7 = paddingByte(getBit(buf[index], 1, 7));
        const _8 = paddingByte(buf[index + 1]);
        c.pictureId = parseInt(_7 + _8, 2);
        index += 2;
      } else {
        c.pictureId = getBit(buf[index], 1, 7);
        index++;
      }
    }

    c.tid = getBit(buf[index], 0, 3);
    c.u = getBit(buf[index], 3);
    c.sid = getBit(buf[index], 4, 3);
    c.d = getBit(buf[index], 7);

    return c;
  }

  get isKeyframe() {
    return !this.p && this.b && (!this.sid || !this.l);
  }
}
