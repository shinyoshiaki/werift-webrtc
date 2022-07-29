// RTP Payload Format For AV1 https://aomediacodec.github.io/av1-rtp-spec/

import { LEB128 } from "@minhducsun2002/leb128";
import { debug } from "debug";

import { RtpHeader } from "..";
import { BitWriter2, getBit } from "../../../common/src";

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
      const [elementSize, bytes] = leb128decode(buf.slice(offset));

      const start = offset + bytes;
      const end = start + elementSize;

      let isFragment = false;
      if (p.zBit_RtpStartsWithFragment && i === 0) {
        isFragment = true;
      }
      p.obu_or_fragment.push({ data: buf.slice(start, end), isFragment });

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
      data: buf.slice(offset),
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
          i
        ) => {
          acc[i] = cur;
          return acc;
        },
        {}
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

    obu.payload = buf.slice(offset);

    return obu;
  }

  serialize() {
    const header = new BitWriter2(8)
      .set(this.obu_forbidden_bit)
      .set(OBU_TYPE_IDS[this.obu_type], 4)
      .set(this.obu_extension_flag)
      .set(this.obu_has_size_field)
      .set(this.obu_reserved_1bit).buffer;
    let obuSize = Buffer.alloc(0);
    if (this.obu_has_size_field) {
      obuSize = LEB128.encode(this.payload.length);
    }
    return Buffer.concat([header, obuSize, this.payload]);
  }
}

export function leb128decode(buf: Buffer) {
  let value = 0;
  let leb128bytes = 0;
  for (let i = 0; i < 8; i++) {
    const leb128byte = buf.readUInt8(i);
    value |= (leb128byte & 0x7f) << (i * 7);
    leb128bytes++;
    if (!(leb128byte & 0x80)) {
      break;
    }
  }
  return [value, leb128bytes];
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
type OBU_TYPE = typeof OBU_TYPES[keyof typeof OBU_TYPES];
const OBU_TYPE_IDS: Record<OBU_TYPE, number> = Object.entries(OBU_TYPES).reduce(
  (acc: any, [key, value]) => {
    acc[value] = Number(key);
    return acc;
  },
  {}
);
