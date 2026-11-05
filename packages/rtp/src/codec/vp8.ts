// RFC 7741 — RTP Payload Format for VP8 Video
// docs/rfc/rfc7741.txt
//
// Payload Descriptor (RFC 7741 §4.2):
//   X|R|N|S|R|PID
// Packetizer emits the same 4-octet form as libwebrtc single-layer senders:
// X=1, I=1, M=1 (15-bit PictureID), L=T=K=0, single partition PID=0.
//   First chunk of a frame: S=1 → 0x90 0x80 PictureID(2 octets, M=1)
//   Continuation chunks:    S=0 → 0x80 0x80 PictureID(2 octets, M=1)
// PictureID increments by 1 per frame (15-bit wrap); all fragments of a frame
// share it. X=1 is required by SFUs such as mediasoup <= 3.19.2, which drop
// X=0 VP8 as unparsable and never detect its keyframes.
// Marker: last RTP packet of the frame (RFC 7741 §4.1).
// VP8 Payload Header P bit (keyframe when P=0) is left untouched in the
// bitstream; only present when S=1 && PID=0 (RFC 7741 §4.3).

import { getBit, paddingByte, random16 } from "../../../common/src";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import { assertRtpCodecPayloadLength } from "./assertPayload";
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
    assertRtpCodecPayloadLength(buf, 1, "VP8", offset);

    p.xBit = getBit(buf[offset], 0);
    p.nBit = getBit(buf[offset], 2);
    p.sBit = getBit(buf[offset], 3);
    p.pid = getBit(buf[offset], 5, 3);
    offset++;

    if (p.xBit) {
      assertRtpCodecPayloadLength(buf, 1, "VP8", offset);
      p.iBit = getBit(buf[offset], 0);
      p.lBit = getBit(buf[offset], 1);
      p.tBit = getBit(buf[offset], 2);
      p.kBit = getBit(buf[offset], 3);
      offset++;
    }

    if (p.iBit) {
      assertRtpCodecPayloadLength(buf, 1, "VP8", offset);
      p.mBit = getBit(buf[offset], 0);
      if (p.mBit) {
        assertRtpCodecPayloadLength(buf, 2, "VP8", offset);
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
      assertRtpCodecPayloadLength(buf, 1, "VP8", offset);
      offset++;
    }

    if (p.lBit || p.kBit) {
      if (p.tBit) {
      }
      if (p.kBit) {
      }
      assertRtpCodecPayloadLength(buf, 1, "VP8", offset);
      offset++;
    }

    p.payload = buf.subarray(offset);

    if (p.payloadHeaderExist) {
      assertRtpCodecPayloadLength(buf, 3, "VP8", offset);
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

export type Vp8PacketizerOptions = PacketizerBaseOptions & {
  /** Initial 15-bit PictureID (default random). */
  pictureId?: number;
};

/** Length of the descriptor emitted by {@link createVp8PayloadDescriptor}. */
export const VP8_PAYLOAD_DESCRIPTOR_LENGTH = 4;

const VP8_PICTURE_ID_MASK = 0x7fff;

/**
 * Build the 4-octet VP8 payload descriptor X=1, I=1, M=1 (RFC 7741 §4.2).
 * `start` sets S (first packet of the frame, PID=0).
 */
export function createVp8PayloadDescriptor({
  start,
  pictureId,
}: {
  start: boolean;
  pictureId: number;
}): Buffer {
  const pid = pictureId & VP8_PICTURE_ID_MASK;
  return Buffer.from([
    0x80 | (start ? 0x10 : 0x00),
    0x80,
    0x80 | (pid >> 8),
    pid & 0xff,
  ]);
}

/**
 * Packetize one VP8 frame (single partition PID=0) into RTP packets.
 * Each packet carries the 4-octet descriptor from
 * {@link createVp8PayloadDescriptor}; PictureID advances once per frame.
 */
export class Vp8Packetizer extends PacketizerBase {
  private pictureId: number;

  constructor(options: Vp8PacketizerOptions = {}) {
    super(options);
    this.pictureId = (options.pictureId ?? random16()) & VP8_PICTURE_ID_MASK;
  }

  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }
    // Descriptor length = 4 (X/I/M); chunk size = maxPayloadSize − 4
    const chunkSize = this.maxPayloadSize - VP8_PAYLOAD_DESCRIPTOR_LENGTH;
    if (chunkSize <= 0) {
      throw new Error(
        `Vp8Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for VP8 descriptor`,
      );
    }

    const pictureId = this.pictureId;
    this.pictureId = (this.pictureId + 1) & VP8_PICTURE_ID_MASK;

    const packets: RtpPacket[] = [];
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(
        offset,
        Math.min(data.length, offset + chunkSize),
      );
      // S=1 on partition start (frame start for PID=0), else S=0 (RFC 7741 §4.2)
      const descriptor = createVp8PayloadDescriptor({
        start: offset === 0,
        pictureId,
      });
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
