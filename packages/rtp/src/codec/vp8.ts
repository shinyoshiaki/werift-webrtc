import { getBit, paddingByte } from "../utils";

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
    const vp8 = new Vp8RtpPayload();

    let index = 0;

    vp8.x = getBit(buf[index], 0);
    vp8.n = getBit(buf[index], 2);
    vp8.s = getBit(buf[index], 3);
    vp8.pid = getBit(buf[index], 5, 3);

    index++;

    if (vp8.x === 1) {
      vp8.i = getBit(buf[index], 0);
      vp8.l = getBit(buf[index], 1);
      vp8.t = getBit(buf[index], 2);
      vp8.k = getBit(buf[index], 3);

      index++;

      if (vp8.i) {
        vp8.m = getBit(buf[index], 0);

        const _7 = paddingByte(getBit(buf[index], 1, 7));
        const _8 = paddingByte(buf[index + 1]);
        vp8.pictureId = parseInt(_7 + _8, 2);

        if (vp8.m === 0) {
          index++;
        } else {
          index += 2;
        }
      }
    }

    if (vp8.s === 1 && vp8.pid === 0) {
      vp8.size0 = getBit(buf[index], 0, 3);
      vp8.h = getBit(buf[index], 3);
      vp8.ver = getBit(buf[index], 4, 3);
      vp8.p = getBit(buf[index], 7);
    }

    return vp8;
  }

  get isKeyframe() {
    return this.p === 0;
  }
}
