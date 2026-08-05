// RFC 7741 — RTP Payload Format for VP8 Video
// docs/rfc/rfc7741.txt
//
// Payload Descriptor (required 1 octet, RFC 7741 §4.2):
//   X|R|N|S|R|PID
// Minimal packetizer: X=0 (no extensions), single partition PID=0.
//   First chunk of a frame: S=1 → descriptor 0x10
//   Continuation chunks:    S=0 → descriptor 0x00
// Marker: last RTP packet of the frame (RFC 7741 §4.1).
// VP8 Payload Header P bit (keyframe when P=0) is left untouched in the
// bitstream; only present when S=1 && PID=0 (RFC 7741 §4.3).

import { getBit, paddingByte } from "../../../common/src";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

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

export class Vp8RtpPayload implements DePacketizerBase {
  xBit!: number;
  nBit!: number;
  sBit!: number;
  pid!: number;
  iBit?: number;
  lBit?: number;
  tBit?: number;
  kBit?: number;
  mBit?: number;
  pictureId?: number;
  payload!: Buffer;
  size0 = 0;
  hBit?: number;
  ver?: number;
  pBit?: number;
  size1 = 0;
  size2 = 0;

  static deSerialize(buf: Buffer) {
    const p = new Vp8RtpPayload();

    let offset = 0;

    p.xBit = getBit(buf[offset], 0);
    p.nBit = getBit(buf[offset], 2);
    p.sBit = getBit(buf[offset], 3);
    p.pid = getBit(buf[offset], 5, 3);
    offset++;

    if (p.xBit) {
      p.iBit = getBit(buf[offset], 0);
      p.lBit = getBit(buf[offset], 1);
      p.tBit = getBit(buf[offset], 2);
      p.kBit = getBit(buf[offset], 3);
      offset++;
    }

    if (p.iBit) {
      p.mBit = getBit(buf[offset], 0);
      if (p.mBit) {
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
      offset++;
    }

    if (p.lBit || p.kBit) {
      if (p.tBit) {
      }
      if (p.kBit) {
      }
      offset++;
    }

    p.payload = buf.subarray(offset);

    if (p.payloadHeaderExist) {
      p.size0 = getBit(buf[offset], 0, 3);
      p.hBit = getBit(buf[offset], 3);
      p.ver = getBit(buf[offset], 4, 3);
      p.pBit = getBit(buf[offset], 7);
      offset++;
      p.size1 = buf[offset];
      offset++;
      p.size2 = buf[offset];
    }

    return p;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return this.pBit === 0;
  }

  get isPartitionHead() {
    return this.sBit === 1;
  }

  get payloadHeaderExist() {
    return this.sBit === 1 && this.pid === 0;
  }

  get size() {
    if (this.payloadHeaderExist) {
      const size = this.size0 + 8 * this.size1 + 2048 * this.size2;
      return size;
    }
    return 0;
  }
}

export type Vp8PacketizerOptions = PacketizerBaseOptions;

/**
 * Packetize one VP8 frame (single partition PID=0) into RTP packets.
 * Descriptor is the minimal 1-byte form from RFC 7741 §4.2 (X=0).
 */
export class Vp8Packetizer extends PacketizerBase {
  constructor(options: Vp8PacketizerOptions = {}) {
    super(options);
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }
    // Descriptor length = 1 (X=0); chunk size = maxPayloadSize − 1
    const chunkSize = this.maxPayloadSize - 1;
    if (chunkSize <= 0) {
      throw new Error(
        `Vp8Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for VP8 descriptor`,
      );
    }

    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(
        offset,
        Math.min(data.length, offset + chunkSize),
      );
      // S=1 on partition start (frame start for PID=0), else S=0 (RFC 7741 §4.2)
      const descriptor = Buffer.from([offset === 0 ? 0x10 : 0x00]);
      const isLast = offset + chunk.length >= data.length;
      packets.push(
        this.buildPacket(
          Buffer.concat([descriptor, chunk]),
          rtpTimestamp,
          isLast,
        ),
      );
    }
    return packets;
  }
}
