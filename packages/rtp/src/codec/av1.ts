// RTP Payload Format For AV1
// Spec: https://aomediacodec.github.io/av1-rtp-spec/
// Saved: docs/rfc/av1-rtp-spec.html
//
// Aggregation Header (AV1 RTP §4.4):
//   Z|Y|W|N|-|-|-
// Packetizer uses W=1 (single OBU element, no size field) for webrtc parity.
// Z/Y mark fragment continuation; N marks start of a new coded video sequence
// (keyframe, first packet only). N=1 and Z=1 together are forbidden.

import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import { BitWriter, BitWriter2, debug, getBit } from "../imports/common";
import { leb128encode } from "./leb128";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

const log = debug("werift-rtp : packages/rtp/src/codec/av1.ts");

// 4.4 AV1 Aggregation Header
//  0 1 2 3 4 5 6 7
// +-+-+-+-+-+-+-+-+
// |Z|Y| W |N|-|-|-|
// +-+-+-+-+-+-+-+-+

// RTP payload syntax:
// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |Z|Y|0 0|N|-|-|-|  OBU element 1 size (leb128)  |               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+               |
// :                                                               :
// :                      OBU element 1 data                       :
// :                                                               :
// |                                                               |
// |                               +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                               |  OBU element 2 size (leb128)  |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// :                                                               :
// :                       OBU element 2 data                      :
// :                                                               :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// :                                                               :
// :                              ...                              :
// :                                                               :
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |OBU e... N size|                                               |
// +-+-+-+-+-+-+-+-+       OBU element N data      +-+-+-+-+-+-+-+-+
// |                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

// OBU syntax:
//     0 1 2 3 4 5 6 7
//    +-+-+-+-+-+-+-+-+
//    |0| type  |X|S|-| (REQUIRED)
//    +-+-+-+-+-+-+-+-+
// X: | TID |SID|-|-|-| (OPTIONAL)
//    +-+-+-+-+-+-+-+-+
//    |1|             |
//    +-+ OBU payload |
// S: |1|             | (OPTIONAL, variable length leb128 encoded)
//    +-+    size     |
//    |0|             |
//    +-+-+-+-+-+-+-+-+
//    |  OBU payload  |
//    |     ...       |

export class AV1RtpPayload {
  /**
   * RtpStartsWithFragment
   * MUST be set to 1 if the first OBU element is an OBU fragment that is a continuation of an OBU fragment from the previous packet, and MUST be set to 0 otherwise.
   */
  zBit_RtpStartsWithFragment!: number;
  /**
   * RtpEndsWithFragment
   * MUST be set to 1 if the last OBU element is an OBU fragment that will continue in the next packet, and MUST be set to 0 otherwise.
   */
  yBit_RtpEndsWithFragment!: number;
  /**
   * RtpNumObus
   * two bit field that describes the number of OBU elements in the packet. This field MUST be set equal to 0 or equal to the number of OBU elements contained in the packet. If set to 0, each OBU element MUST be preceded by a length field.
   */
  w_RtpNumObus!: number;
  /**
   * RtpStartsNewCodedVideoSequence
   * MUST be set to 1 if the packet is the first packet of a coded video sequence, and MUST be set to 0 otherwise.
   */
  nBit_RtpStartsNewCodedVideoSequence!: number;
  obu_or_fragment: { data: Buffer; isFragment: boolean }[] = [];

  static deSerialize = (buf: Buffer) => {
    const p = new AV1RtpPayload();

    let offset = 0;

    p.zBit_RtpStartsWithFragment = getBit(buf[offset], 0);
    p.yBit_RtpEndsWithFragment = getBit(buf[offset], 1);
    p.w_RtpNumObus = getBit(buf[offset], 2, 2);
    p.nBit_RtpStartsNewCodedVideoSequence = getBit(buf[offset], 4);
    offset++;

    if (p.nBit_RtpStartsNewCodedVideoSequence && p.zBit_RtpStartsWithFragment) {
      throw new Error();
    }

    [...Array(p.w_RtpNumObus - 1).keys()].forEach((i) => {
      const [elementSize, bytes] = leb128decode(buf.subarray(offset));

      const start = offset + bytes;
      const end = start + elementSize;

      let isFragment = false;
      if (p.zBit_RtpStartsWithFragment && i === 0) {
        isFragment = true;
      }
      p.obu_or_fragment.push({ data: buf.subarray(start, end), isFragment });

      offset += bytes + elementSize;
    });
    let isFragment = false;
    if (
      p.yBit_RtpEndsWithFragment ||
      (p.w_RtpNumObus === 1 && p.zBit_RtpStartsWithFragment)
    ) {
      isFragment = true;
    }
    p.obu_or_fragment.push({
      data: buf.subarray(offset),
      isFragment: isFragment,
    });

    return p;
  };

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return this.nBit_RtpStartsNewCodedVideoSequence === 1;
  }

  static getFrame(payloads: AV1RtpPayload[]) {
    const frames: Buffer[] = [];
    const objects = payloads
      .flatMap((p) => p.obu_or_fragment)
      .reduce(
        (
          acc: Record<number, { data: Buffer; isFragment: boolean }>,
          cur,
          i,
        ) => {
          acc[i] = cur;
          return acc;
        },
        {},
      );
    const length = Object.keys(objects).length;

    for (const i of Object.keys(objects).map(Number)) {
      const exist = objects[i];
      if (!exist) continue;
      const { data, isFragment } = exist;
      if (isFragment) {
        let fragments: Buffer[] = [];
        for (let head = i; head < length; head++) {
          const target = objects[head];
          if (target.isFragment) {
            fragments.push(target.data);
            delete objects[head];
          } else {
            break;
          }
        }
        if (fragments.length <= 1) {
          log("fragment lost, maybe packet lost");
          fragments = [];
        }
        frames.push(Buffer.concat(fragments));
      } else {
        frames.push(data);
      }
    }
    const obus = frames.map((f) => AV1Obu.deSerialize(f));
    const lastObu = obus.pop()!;
    return Buffer.concat([
      ...obus.map((o) => {
        o.obu_has_size_field = 1;
        return o.serialize();
      }),
      lastObu.serialize(),
    ]);
  }
}

export class AV1Obu {
  obu_forbidden_bit!: number;
  obu_type!: OBU_TYPE;
  obu_extension_flag!: number;
  obu_has_size_field!: number;
  obu_reserved_1bit!: number;
  payload!: Buffer;

  static deSerialize(buf: Buffer) {
    const obu = new AV1Obu();
    let offset = 0;
    obu.obu_forbidden_bit = getBit(buf[offset], 0);
    obu.obu_type =
      OBU_TYPES[getBit(buf[offset], 1, 4) as keyof typeof OBU_TYPES];
    obu.obu_extension_flag = getBit(buf[offset], 5);
    obu.obu_has_size_field = getBit(buf[offset], 6);
    obu.obu_reserved_1bit = getBit(buf[offset], 7);
    offset++;

    obu.payload = buf.subarray(offset);

    return obu;
  }

  serialize() {
    const header = new BitWriter2(8)
      .set(this.obu_forbidden_bit)
      .set(OBU_TYPE_IDS[this.obu_type], 4)
      .set(this.obu_extension_flag)
      .set(this.obu_has_size_field)
      .set(this.obu_reserved_1bit).buffer;
    let obuSize: Buffer = Buffer.alloc(0);
    if (this.obu_has_size_field) {
      obuSize = leb128encode(this.payload.length);
    }
    return Buffer.concat([header, obuSize, this.payload]);
  }
}

export function leb128decode(buf: Buffer) {
  let value = 0;
  let leb128bytes = 0;
  for (let i = 0; i < 8; i++) {
    if (i >= buf.length) {
      throw new Error("LEB128 decode incomplete");
    }
    const leb128byte = buf.readUInt8(i);
    value += (leb128byte & 0x7f) * 128 ** i;
    leb128bytes++;
    if (!(leb128byte & 0x80)) {
      if (!Number.isSafeInteger(value)) {
        throw new Error("LEB128 value exceeds safe integer");
      }
      return [value, leb128bytes];
    }
  }
  throw new Error("LEB128 decode incomplete");
}

const OBU_TYPES = {
  0: "Reserved",
  1: "OBU_SEQUENCE_HEADER",
  2: "OBU_TEMPORAL_DELIMITER",
  3: "OBU_FRAME_HEADER",
  4: "OBU_TILE_GROUP",
  5: "OBU_METADATA",
  6: "OBU_FRAME",
  7: "OBU_REDUNDANT_FRAME_HEADER",
  8: "OBU_TILE_LIST",
  15: "OBU_PADDING",
} as const;
type OBU_TYPE = (typeof OBU_TYPES)[keyof typeof OBU_TYPES];
const OBU_TYPE_IDS: Record<OBU_TYPE, number> = Object.entries(OBU_TYPES).reduce(
  (acc: any, [key, value]) => {
    acc[value] = Number(key);
    return acc;
  },
  {},
);

// ---------------------------------------------------------------------------
// Packetizer helpers (canonical location; webrtc may mirror for EncodedPacket)
// ---------------------------------------------------------------------------

/**
 * Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4) with W=1.
 * N=1 and Z=1 must not both be set (deSerialize throws).
 */
export function createAv1AggregationHeader({
  startsWithFragment,
  endsWithFragment,
  startsNewCodedVideoSequence,
}: {
  startsWithFragment: boolean;
  endsWithFragment: boolean;
  startsNewCodedVideoSequence: boolean;
}): Buffer {
  if (startsWithFragment && startsNewCodedVideoSequence) {
    throw new Error(
      "AV1 aggregation header: N=1 and Z=1 must not both be set (AV1 RTP §4.4)",
    );
  }
  // Z|Y|W=1|N|000
  return new BitWriter(8)
    .set(1, 0, startsWithFragment ? 1 : 0)
    .set(1, 1, endsWithFragment ? 1 : 0)
    .set(2, 2, 1)
    .set(1, 4, startsNewCodedVideoSequence ? 1 : 0)
    .set(3, 5, 0).buffer;
}

/**
 * Split an AV1 sample into OBU elements.
 * Accepts size-field and no-size-field (remainder is last OBU) layouts.
 */
export function splitAv1Obus(sample: Buffer): Buffer[] {
  const obus: Buffer[] = [];
  let offset = 0;

  while (offset < sample.length) {
    const start = offset;
    const header = sample[offset];
    offset += 1;
    if (header == undefined) {
      break;
    }

    const extensionFlag = getBit(header, 5);
    const hasSizeField = getBit(header, 6);
    if (extensionFlag) {
      if (offset >= sample.length) {
        throw new Error("invalid AV1 OBU: extension flag set but buffer ends");
      }
      offset += 1;
    }

    if (!hasSizeField) {
      // Remainder of the buffer is this OBU
      obus.push(sample.subarray(start));
      break;
    }

    const [obuSize, leb128Length] = leb128decode(sample.subarray(offset));
    offset += leb128Length;
    const end = offset + obuSize;
    if (end > sample.length) {
      throw new Error("invalid AV1 OBU size");
    }
    obus.push(sample.subarray(start, end));
    offset = end;
  }

  return obus;
}

export type Av1PacketizerOptions = PacketizerBaseOptions & {
  /**
   * Default keyframe flag (N bit on first packet of the frame).
   * Override per call via packetize(..., { isKeyframe }).
   */
  isKeyframe?: boolean;
};

export type Av1PacketizeOptions = {
  isKeyframe?: boolean;
  frameType?: "key" | "delta";
};

/**
 * Packetize one AV1 access unit (OBU sequence) into RTP packets.
 * Uses W=1 single-element payloads; fragments large OBUs with Z/Y bits.
 */
export class Av1Packetizer extends PacketizerBase {
  private readonly defaultIsKeyframe: boolean;

  constructor(options: Av1PacketizerOptions = {}) {
    super(options);
    this.defaultIsKeyframe = options.isKeyframe ?? false;
  }

  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options: Av1PacketizeOptions = {},
  ): RtpPacket[] {
    if (data.length === 0) {
      return [];
    }

    let isKeyframe = this.defaultIsKeyframe;
    if (options.frameType === "key") isKeyframe = true;
    else if (options.frameType === "delta") isKeyframe = false;
    else if (options.isKeyframe !== undefined) isKeyframe = options.isKeyframe;

    const obus = splitAv1Obus(data);
    if (obus.length === 0) {
      throw new Error("AV1 sample did not contain any OBU data");
    }

    // Aggregation header = 1 byte
    const fragmentSize = this.maxPayloadSize - 1;
    if (fragmentSize <= 0) {
      throw new Error(
        `Av1Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for aggregation header`,
      );
    }

    const packets: RtpPacket[] = [];
    let firstPacketInFrame = true;

    for (const obu of obus) {
      if (obu.length <= fragmentSize) {
        const aggregationHeader = createAv1AggregationHeader({
          startsWithFragment: false,
          endsWithFragment: false,
          startsNewCodedVideoSequence: firstPacketInFrame && isKeyframe,
        });
        packets.push(
          this.buildPacket(
            Buffer.concat([aggregationHeader, obu]),
            rtpTimestamp,
            false,
          ),
        );
        firstPacketInFrame = false;
        continue;
      }

      for (let offset = 0; offset < obu.length; offset += fragmentSize) {
        const chunk = obu.subarray(
          offset,
          Math.min(obu.length, offset + fragmentSize),
        );
        const aggregationHeader = createAv1AggregationHeader({
          startsWithFragment: offset > 0,
          endsWithFragment: offset + chunk.length < obu.length,
          startsNewCodedVideoSequence: firstPacketInFrame && isKeyframe,
        });
        packets.push(
          this.buildPacket(
            Buffer.concat([aggregationHeader, chunk]),
            rtpTimestamp,
            false,
          ),
        );
        firstPacketInFrame = false;
      }
    }

    // Marker on last packet of the frame (AV1 RTP marker bit semantics)
    packets.at(-1)!.header.marker = true;
    return packets;
  }
}
