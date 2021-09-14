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
  /**Picture ID (PID) present */
  iBit!: number;
  /**Inter-picture predicted frame */
  pBit!: number;
  /**Layer indices present */
  lBit!: number;
  /**Flexible mode */
  fBit!: number;
  /**Start of a frame */
  bBit!: number;
  /**End of a frame */
  eBit!: number;
  /**Scalability structure */
  vBit!: number;
  zBit!: number;
  m?: number;
  pictureId?: number;
  tid?: number;
  u?: number;
  sid?: number;
  /**inter_layer_predicted */
  d?: number;
  tl0PicIdx?: number;
  pDiff: number[] = [];
  n_s?: number;
  y?: number;
  g?: number;
  width: number[] = [];
  height: number[] = [];
  n_g: number = 0;
  pgT: number[] = [];
  pgU: number[] = [];
  pgP_Diff: number[][] = [];
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const { p, offset } = this.parseRtpPayload(buf);
    p.payload = buf.slice(offset);
    return p;
  }

  static parseRtpPayload(buf: Buffer) {
    const p = new Vp9RtpPayload();
    let offset = 0;

    p.iBit = getBit(buf[offset], 0); // PictureId present .
    p.pBit = getBit(buf[offset], 1); // Inter-picture predicted.
    p.lBit = getBit(buf[offset], 2); // Layer indices present.
    p.fBit = getBit(buf[offset], 3); // Flexible mode.
    p.bBit = getBit(buf[offset], 4); // Begins frame flag.
    p.eBit = getBit(buf[offset], 5); // Ends frame flag.
    p.vBit = getBit(buf[offset], 6); // Scalability structure present.
    p.zBit = getBit(buf[offset], 7); // Not used for inter-layer prediction
    offset++;

    if (p.iBit) {
      p.m = getBit(buf[offset], 0);

      if (p.m) {
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
      p.tid = getBit(buf[offset], 0, 3);
      p.u = getBit(buf[offset], 3);
      p.sid = getBit(buf[offset], 4, 3);
      p.d = getBit(buf[offset], 7);
      offset++;
      if (p.fBit === 0) {
        p.tl0PicIdx = buf[offset];
        offset++;
      }
    }

    if (p.fBit && p.pBit) {
      for (;;) {
        p.pDiff = [...p.pDiff, getBit(buf[offset], 0, 7)];
        const n = getBit(buf[offset], 7);
        offset++;
        if (n === 0) break;
      }
    }

    // Scalability structure (SS):
    //
    //      +-+-+-+-+-+-+-+-+
    // V:   | N_S |Y|G|-|-|-|
    //      +-+-+-+-+-+-+-+-+              -|
    // Y:   |     WIDTH     | (OPTIONAL)    .
    //      +               +               .
    //      |               | (OPTIONAL)    .
    //      +-+-+-+-+-+-+-+-+               . N_S + 1 times
    //      |     HEIGHT    | (OPTIONAL)    .
    //      +               +               .
    //      |               | (OPTIONAL)    .
    //      +-+-+-+-+-+-+-+-+              -|
    // G:   |      N_G      | (OPTIONAL)
    //      +-+-+-+-+-+-+-+-+                           -|
    // N_G: |  T  |U| R |-|-| (OPTIONAL)                 .
    //      +-+-+-+-+-+-+-+-+              -|            . N_G times
    //      |    P_DIFF     | (OPTIONAL)    . R times    .
    //      +-+-+-+-+-+-+-+-+              -|           -|
    //
    if (p.vBit) {
      p.n_s = getBit(buf[offset], 0, 3);
      p.y = getBit(buf[offset], 3);
      p.g = getBit(buf[offset], 4);
      offset++;

      if (p.y) {
        [...Array(p.n_s + 1)].forEach(() => {
          p.width.push(buf.readUInt16BE(offset));
          offset += 2;
          p.height.push(buf.readUInt16BE(offset));
          offset += 2;
        });
      }

      if (p.g) {
        p.n_g = buf[offset];
        offset++;
      }

      if (p.n_g > 0) {
        [...Array(p.n_g).keys()].forEach((i) => {
          p.pgT.push(getBit(buf[offset], 0, 3));
          p.pgU.push(getBit(buf[offset], 3));
          const r = getBit(buf[offset], 4, 2);
          offset++;

          p.pgP_Diff[i] = [];
          if (r > 0) {
            [...Array(r)].forEach(() => {
              p.pgP_Diff[i].push(buf[offset]);
              offset++;
            });
          }
        });
      }
    }
    return { offset, p };
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return !!(!this.pBit && this.bBit && (!this.sid || !this.lBit));
  }

  get isPartitionHead() {
    return this.bBit && (!this.lBit || !this.d);
  }
}
