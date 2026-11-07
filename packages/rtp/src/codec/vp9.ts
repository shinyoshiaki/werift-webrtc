// RFC 9628 — RTP Payload Format for VP9 Video (Standards Track, March 2025)
// docs/rfc/rfc9628.txt
// (Supersedes draft-ietf-payload-vp9; implement against the RFC, not the draft.)
//
// Payload Descriptor first octet (RFC 9628):
//   I|P|L|F|B|E|V|Z
// Minimal packetizer subset (legal RFC profile):
//   I=L=F=V=Z=0, P=0 key / P=1 inter, B=start of frame, E=end of frame.
// Marker: last RTP packet of the frame.

import { BitWriter, getBit, paddingByte } from "../../../common/src";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

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
  n_g = 0;
  pgT: number[] = [];
  pgU: number[] = [];
  pgP_Diff: number[][] = [];
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const { p, offset } = this.parseRtpPayload(buf);
    p.payload = buf.subarray(offset);
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
        p.pictureId = Number.parseInt(_7 + _8, 2);
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

export type Vp9PacketizerOptions = PacketizerBaseOptions & {
  /**
   * When true, set P=0 (not inter-predicted = keyframe).
   * When false, set P=1 (inter-predicted / delta). Default false.
   * Also accept via packetize(..., { isKeyframe }) override.
   */
  isKeyframe?: boolean;
};

export type Vp9PacketizeOptions = {
  /** Override keyframe (P bit). Key → P=0, delta → P=1 (RFC 9628). */
  isKeyframe?: boolean;
  /** Alias for isKeyframe false / true: "key" | "delta". */
  frameType?: "key" | "delta";
};

/**
 * Packetize one VP9 frame with the minimal 1-byte descriptor (RFC 9628).
 * Picture ID / layer / SS extensions are not sent (legal optional subset).
 */
export class Vp9Packetizer extends PacketizerBase {
  private readonly defaultIsKeyframe: boolean;

  constructor(options: Vp9PacketizerOptions = {}) {
    super(options);
    this.defaultIsKeyframe = options.isKeyframe ?? false;
  }

  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options: Vp9PacketizeOptions = {},
  ): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }
    const chunkSize = this.maxPayloadSize - 1;
    if (chunkSize <= 0) {
      throw new Error(
        `Vp9Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for VP9 descriptor`,
      );
    }

    let isKeyframe = this.defaultIsKeyframe;
    if (options.frameType === "key") isKeyframe = true;
    else if (options.frameType === "delta") isKeyframe = false;
    else if (options.isKeyframe !== undefined) isKeyframe = options.isKeyframe;

    // P=1 when inter-predicted (delta), P=0 for key (RFC 9628)
    const pBit = isKeyframe ? 0 : 1;

    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(
        offset,
        Math.min(data.length, offset + chunkSize),
      );
      const isStart = offset === 0;
      const isEnd = offset + chunk.length >= data.length;
      // I|P|L|F|B|E|V|Z — only P, B, E set in the minimal form
      const descriptor = new BitWriter(8)
        .set(1, 0, 0) // I
        .set(1, 1, pBit) // P
        .set(1, 2, 0) // L
        .set(1, 3, 0) // F
        .set(1, 4, isStart ? 1 : 0) // B
        .set(1, 5, isEnd ? 1 : 0) // E
        .set(1, 6, 0) // V
        .set(1, 7, 0).buffer; // Z
      packets.push(
        this.buildPacket(
          Buffer.concat([descriptor, chunk]),
          rtpTimestamp,
          isEnd,
        ),
      );
    }
    return packets;
  }
}
