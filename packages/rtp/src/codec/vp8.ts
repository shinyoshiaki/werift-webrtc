import { getBit, paddingByte } from "../../../common/src";

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

export class Vp8RtpPayload {
  x!: number;
  n!: number;
  s!: number;
  pid!: number;
  i?: number;
  l?: number;
  t?: number;
  k?: number;
  m?: number;
  pictureId?: number;
  size0?: number;
  h?: number;
  ver?: number;
  p?: number;

  static deSerialize(buf: Buffer) {
    const c = new Vp8RtpPayload();

    let index = 0;

    c.x = getBit(buf[index], 0);
    c.n = getBit(buf[index], 2);
    c.s = getBit(buf[index], 3);
    c.pid = getBit(buf[index], 5, 3);

    index++;

    if (c.x === 1) {
      c.i = getBit(buf[index], 0);
      c.l = getBit(buf[index], 1);
      c.t = getBit(buf[index], 2);
      c.k = getBit(buf[index], 3);

      index++;

      if (c.i) {
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
    }

    if (c.s === 1 && c.pid === 0) {
      c.size0 = getBit(buf[index], 0, 3);
      c.h = getBit(buf[index], 3);
      c.ver = getBit(buf[index], 4, 3);
      c.p = getBit(buf[index], 7);
    }

    return c;
  }

  get isKeyframe() {
    return this.p === 0;
  }
}
