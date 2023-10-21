// RFC 6184 - RTP Payload Format for H.264 Video
// pion/rtp

import { BitStream, getBit } from "../../../common/src";
import { RtpHeader } from "../rtp/rtp";
import { DePacketizerBase } from "./base";

// FU indicator octet
// +---------------+
// |0|1|2|3|4|5|6|7|
// +-+-+-+-+-+-+-+-+
// |F|NRI|  Type   |
// +---------------+

// FU header
// +---------------+
// |0|1|2|3|4|5|6|7|
// +-+-+-+-+-+-+-+-+
// |S|E|R|  Type   |
// +---------------+

// NAL Unit Type     Content of NAL Unit              NRI (binary)
// ----------------------------------------------------------------
//  1              non-IDR coded slice                         10
//  2              Coded slice data partition A                10
//  3              Coded slice data partition B                01
//  4              Coded slice data partition C                01

// Payload Packet    Single NAL    Non-Interleaved    Interleaved
// Type    Type      Unit Mode           Mode             Mode
// -------------------------------------------------------------
// 0      reserved      ig               ig               ig
// 1-23   NAL unit     yes              yes               no
// 24     STAP-A        no              yes               no
// 25     STAP-B        no               no              yes
// 26     MTAP16        no               no              yes
// 27     MTAP24        no               no              yes
// 28     FU-A          no              yes              yes
// 29     FU-B          no               no              yes
// 30-31  reserved      ig               ig               ig

export class H264RtpPayload implements DePacketizerBase {
  /**forbidden_zero_bit */
  f!: number;
  /**nal_ref_idc */
  nri!: number;
  /**nal_unit_types */
  nalUnitType!: number;
  /**start of a fragmented NAL unit */
  s!: number;
  /**end of a fragmented NAL unit */
  e!: number;
  r!: number;
  nalUnitPayloadType!: number;
  payload!: Buffer;
  fragment?: Buffer;

  static deSerialize(buf: Buffer, fragment?: Buffer) {
    const h264 = new H264RtpPayload();

    let offset = 0;

    const naluHeader = buf[offset];
    h264.f = getBit(naluHeader, 0);
    h264.nri = getBit(naluHeader, 1, 2);
    h264.nalUnitType = getBit(naluHeader, 3, 5);
    offset++;

    h264.s = getBit(buf[offset], 0);
    h264.e = getBit(buf[offset], 1);
    h264.r = getBit(buf[offset], 2);
    h264.nalUnitPayloadType = getBit(buf[offset], 3, 5);
    offset++;

    // デフォルトでは packetization-mode=0
    // packetization-mode=0だとSingle NAL Unit Packetしか来ない
    // https://datatracker.ietf.org/doc/html/rfc6184#section-6.2

    // Single NAL Unit Packet
    if (0 < h264.nalUnitType && h264.nalUnitType < NalUnitType.stap_a) {
      h264.payload = this.packaging(buf);
    }
    // Single-time aggregation packet
    else if (h264.nalUnitType === NalUnitType.stap_a) {
      let offset = stap_aHeaderSize;
      let result: Buffer = Buffer.alloc(0);
      while (offset < buf.length) {
        const naluSize = buf.readUInt16BE(offset);
        offset += stap_aNALULengthSize;

        result = Buffer.concat([
          result,
          this.packaging(buf.subarray(offset, offset + naluSize)),
        ]);
        offset += naluSize;
      }
      h264.payload = result;
    }
    // Fragmentation Units
    else if (h264.nalUnitType === NalUnitType.fu_a) {
      if (!fragment) {
        fragment = Buffer.alloc(0);
      }
      const fu = buf.subarray(offset);
      h264.fragment = Buffer.concat([fragment, fu]);

      if (h264.e) {
        const bitStream = new BitStream(Buffer.alloc(1))
          .writeBits(1, 0)
          .writeBits(2, h264.nri)
          .writeBits(5, h264.nalUnitPayloadType);
        const nalu = Buffer.concat([bitStream.uint8Array, h264.fragment]);
        h264.fragment = undefined;
        h264.payload = this.packaging(nalu);
      }
    }

    return h264;
  }

  private static packaging(buf: Buffer) {
    return Buffer.concat([annex_bNALUStartCode, buf]);
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return (
      this.nalUnitType === NalUnitType.idrSlice ||
      this.nalUnitPayloadType === NalUnitType.idrSlice
    );
  }

  get isPartitionHead() {
    if (
      this.nalUnitType === NalUnitType.fu_a ||
      this.nalUnitType === NalUnitType.fu_b
    ) {
      return this.s !== 0;
    }

    return true;
  }
}

export const NalUnitType = {
  idrSlice: 5,
  stap_a: 24,
  stap_b: 25,
  mtap16: 26,
  mtap24: 27,
  fu_a: 28,
  fu_b: 29,
} as const;

const annex_bNALUStartCode = Buffer.from([0x00, 0x00, 0x00, 0x01]);

const stap_aHeaderSize = 1;
const stap_aNALULengthSize = 2;
