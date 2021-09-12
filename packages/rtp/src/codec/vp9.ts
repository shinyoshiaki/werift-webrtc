// RTP Payload Format for VP9 Video draft-ietf-payload-vp9-16 https://datatracker.ietf.org/doc/html/draft-ietf-payload-vp9

import { getBit, paddingByte } from "../../../common/src";
import { RtpHeader } from "../rtp/rtp";
import { DePacketizerBase } from "./base";

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

export class Vp9RtpPayload implements DePacketizerBase {
  i!: number;
  /**Inter-picture predicted frame */
  p!: number;
  /**Layer indices present */
  l!: number;
  /**Flexible mode */
  f!: number;
  /**Start of a frame */
  b!: number;
  e!: number;
  /**Scalability structure */
  v!: number;
  z!: number;
  m?: number;
  pictureId?: number;
  tid?: number;
  u?: number;
  sid?: number;
  d?: number;
  tl0PicIdx?: number;
  pDiff: number[] = [];
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const p = new Vp9RtpPayload();

    let offset = 0;

    p.i = getBit(buf[offset], 0);
    p.p = getBit(buf[offset], 1);
    p.l = getBit(buf[offset], 2);
    p.f = getBit(buf[offset], 3);
    p.b = getBit(buf[offset], 4);
    p.e = getBit(buf[offset], 5);
    p.v = getBit(buf[offset], 6);
    p.z = getBit(buf[offset], 7);

    offset++;

    if (p.i === 1) {
      p.m = getBit(buf[offset], 0);

      if (p.m === 1) {
        const _7 = paddingByte(getBit(buf[offset], 1, 7));
        const _8 = paddingByte(buf[offset + 1]);
        p.pictureId = parseInt(_7 + _8, 2);
        offset += 2;
      } else {
        p.pictureId = getBit(buf[offset], 1, 7);
        offset++;
      }
    }

    if (p.l) {
      p.tid = getBit(buf[offset], 0, 3);
      p.u = getBit(buf[offset], 3);
      p.sid = getBit(buf[offset], 4, 3);
      p.d = getBit(buf[offset], 7);
      offset++;
      if (p.f === 0) {
        p.tl0PicIdx = buf[offset];
        offset++;
      }
    }

    if (p.f && p.p) {
      for (;;) {
        p.pDiff = [...p.pDiff, getBit(buf[offset], 0, 7)];
        const n = getBit(buf[offset], 7);
        offset++;
        if (n === 0) break;
      }
    }

    if (p.v) {
    }

    return p;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return !!(!this.p && this.b && (!this.sid || !this.l));
  }

  get isPartitionHead() {
    return this.b === 1;
  }
}
