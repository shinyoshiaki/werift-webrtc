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
  frame?: Buffer;
  size0?: number;
  h?: number;
  ver?: number;
  p?: number;
  size1?: number;
  size2?: number;
  payload?: Buffer;

  static deSerialize(buf: Buffer) {
    const c = new Vp8RtpPayload();

    let offset = 0;

    c.x = getBit(buf[offset], 0);
    c.n = getBit(buf[offset], 2);
    c.s = getBit(buf[offset], 3);
    c.pid = getBit(buf[offset], 5, 3);

    offset++;

    if (c.x === 1) {
      c.i = getBit(buf[offset], 0);
      c.l = getBit(buf[offset], 1);
      c.t = getBit(buf[offset], 2);
      c.k = getBit(buf[offset], 3);

      offset++;

      if (c.i) {
        c.m = getBit(buf[offset], 0);

        if (c.m === 1) {
          const _7 = paddingByte(getBit(buf[offset], 1, 7));
          const _8 = paddingByte(buf[offset + 1]);
          c.pictureId = parseInt(_7 + _8, 2);
          offset += 2;
        } else {
          c.pictureId = getBit(buf[offset], 1, 7);
          offset++;
        }
      }
    }

    c.frame = buf.slice(offset);

    if (c.s === 1 && c.pid === 0) {
      c.size0 = getBit(buf[offset], 0, 3);
      c.h = getBit(buf[offset], 3);
      c.ver = getBit(buf[offset], 4, 3);
      c.p = getBit(buf[offset], 7);
      offset++;
    }

    c.size1 = buf[offset];
    offset++;
    c.size2 = buf[offset];
    offset++;
    c.payload = buf.slice(offset);

    return c;
  }

  get isKeyframe() {
    return this.p === 0;
  }
}
