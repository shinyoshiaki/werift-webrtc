// RFC 6184 - RTP Payload Format for H.264 Video

import { getBit } from "../../../common/src";
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

  static deSerialize(buf: Buffer) {
    const h264 = new H264RtpPayload();

    let offset = 0;

    h264.f = getBit(buf[offset], 0);
    h264.nri = getBit(buf[offset], 1, 2);
    h264.nalUnitType = getBit(buf[offset], 3, 5);
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
    if (0 < h264.nalUnitType && h264.nalUnitType < 24) {
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

    return h264;
  }

  private static packaging(buf: Buffer) {
    return Buffer.concat([annex_bNALUStartCode, buf]);
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return this.nalUnitType === NalUnitType.idrSlice;
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
