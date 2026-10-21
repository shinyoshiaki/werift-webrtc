// RTP Payload Format For AV1
// Spec: https://aomediacodec.github.io/av1-rtp-spec/
// Saved: docs/rfc/av1-rtp-spec.html
//
// Aggregation Header (AV1 RTP §4.4):
//   Z|Y|W|N|-|-|-
// Packetizer uses W=0 with element lengths so adjacent OBUs can share a packet.
// Z/Y mark fragment continuation; N marks start of a new coded video sequence
// (keyframe, first packet only). N=1 and Z=1 together are forbidden.

import { BitWriter, BitWriter2, debug, getBit } from "../imports/common";
import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";
import { leb128encode } from "./leb128";

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
  obu_or_fragment: {
    data: Buffer;
    isFragment: boolean;
    /** Fragment continues in the next packet (last element with Y=1). */
    continues?: boolean;
    /** Fragment continues an OBU from the previous packet (first element with Z=1). */
    isContinuation?: boolean;
  }[] = [];

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

    if (p.w_RtpNumObus === 0) {
      // W=0: every OBU element, including the last, is preceded by a length
      let i = 0;
      while (offset < buf.length) {
        const [elementSize, bytes] = leb128decode(buf.subarray(offset));
        const start = offset + bytes;
        const end = start + elementSize;
        if (end > buf.length) {
          throw new Error("AV1 OBU element length exceeds payload");
        }
        const isFirst = i === 0;
        const isLast = end >= buf.length;
        const isFragment =
          (isFirst && !!p.zBit_RtpStartsWithFragment) ||
          (isLast && !!p.yBit_RtpEndsWithFragment);
        p.obu_or_fragment.push({
          data: buf.subarray(start, end),
          isFragment,
          continues: isLast && !!p.yBit_RtpEndsWithFragment,
          isContinuation: isFirst && !!p.zBit_RtpStartsWithFragment,
        });
        offset = end;
        i++;
      }
      return p;
    }

    [...Array(p.w_RtpNumObus - 1).keys()].forEach((i) => {
      const [elementSize, bytes] = leb128decode(buf.subarray(offset));

      const start = offset + bytes;
      const end = start + elementSize;

      let isFragment = false;
      if (p.zBit_RtpStartsWithFragment && i === 0) {
        isFragment = true;
      }
      p.obu_or_fragment.push({
        data: buf.subarray(start, end),
        isFragment,
        continues: false,
        isContinuation: isFragment,
      });

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
      continues: !!p.yBit_RtpEndsWithFragment,
      isContinuation: !!p.zBit_RtpStartsWithFragment && p.w_RtpNumObus === 1,
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
    // Adjacent fragmented OBUs (A ends and B starts in the same packet) share
    // isFragment=true, so boundaries come from continues/isContinuation:
    // an OBU starts at a fragment without isContinuation and ends at the first
    // fragment that does not continue into the next packet.
    let pending: Buffer[] = [];
    const flushLost = () => {
      if (pending.length > 0) {
        log("fragment lost, maybe packet lost");
        pending = [];
      }
    };
    for (const {
      data,
      isFragment,
      continues,
      isContinuation,
    } of payloads.flatMap((p) => p.obu_or_fragment)) {
      if (!isFragment) {
        flushLost();
        frames.push(data);
        continue;
      }
      if (!isContinuation) {
        flushLost();
        pending = [data];
      } else if (pending.length === 0) {
        // continuation without a start: head of the OBU was lost
        log("fragment lost, maybe packet lost");
        continue;
      } else {
        pending.push(data);
      }
      if (!continues) {
        if (pending.length > 1) {
          frames.push(Buffer.concat(pending));
        } else {
          log("fragment lost, maybe packet lost");
        }
        pending = [];
      }
    }
    flushLost();
    // Re-serialize OBUs. Non-last OBUs always carry a size field so the
    // bitstream is self-delimiting; the last OBU keeps its original
    // obu_has_size_field (size present or remainder-of-buffer).
    // Size-field LEB128 is re-encoded canonically from the payload body
    // (AV1Obu.deSerialize strips LEB128 into payload-only).
    const obus = frames.map((f) => AV1Obu.deSerialize(f));
    if (obus.length === 0) {
      return Buffer.alloc(0);
    }
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
  /** Present when obu_extension_flag=1 (TID/SID byte). */
  extension_header?: number;
  /** OBU payload body only (LEB128 size field is not part of payload). */
  payload!: Buffer;

  /**
   * Parse one OBU element.
   * When `obu_has_size_field` is set, consumes LEB128 size and takes exactly
   * that many payload octets (AV1 bitstream / AV1 RTP OBU element).
   */
  static deSerialize(buf: Buffer) {
    if (buf.length < 1) {
      throw new Error("AV1 OBU too short: expected at least 1 header byte");
    }
    const obu = new AV1Obu();
    let offset = 0;
    obu.obu_forbidden_bit = getBit(buf[offset], 0);
    obu.obu_type =
      OBU_TYPES[getBit(buf[offset], 1, 4) as keyof typeof OBU_TYPES];
    obu.obu_extension_flag = getBit(buf[offset], 5);
    obu.obu_has_size_field = getBit(buf[offset], 6);
    obu.obu_reserved_1bit = getBit(buf[offset], 7);
    offset++;

    if (obu.obu_extension_flag) {
      if (offset >= buf.length) {
        throw new Error(
          "AV1 OBU: extension flag set but extension byte missing",
        );
      }
      obu.extension_header = buf[offset];
      offset++;
    }

    if (obu.obu_has_size_field) {
      const [obuSize, leb128Length] = leb128decode(buf.subarray(offset));
      offset += leb128Length;
      const end = offset + obuSize;
      if (end > buf.length) {
        throw new Error(
          `AV1 OBU size field ${obuSize} exceeds remaining buffer ${buf.length - offset}`,
        );
      }
      // Payload is body only; size is re-encoded on serialize
      obu.payload = buf.subarray(offset, end);
    } else {
      // No size field: remainder is the payload (typical last OBU)
      obu.payload = buf.subarray(offset);
    }

    return obu;
  }

  serialize() {
    const header = new BitWriter2(8)
      .set(this.obu_forbidden_bit)
      .set(OBU_TYPE_IDS[this.obu_type], 4)
      .set(this.obu_extension_flag)
      .set(this.obu_has_size_field)
      .set(this.obu_reserved_1bit).buffer;
    const ext =
      this.obu_extension_flag && this.extension_header !== undefined
        ? Buffer.from([this.extension_header & 0xff])
        : Buffer.alloc(0);
    let obuSize: Buffer = Buffer.alloc(0);
    if (this.obu_has_size_field) {
      obuSize = leb128encode(this.payload.length);
    }
    return Buffer.concat([header, ext, obuSize, this.payload]);
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
 * Build the 1-byte AV1 Aggregation Header (AV1 RTP §4.4).
 * W defaults to 1; W=0 means every OBU element has a length prefix.
 * N=1 and Z=1 must not both be set (deSerialize throws).
 */
export function createAv1AggregationHeader({
  startsWithFragment,
  endsWithFragment,
  startsNewCodedVideoSequence,
  w = 1,
}: {
  startsWithFragment: boolean;
  endsWithFragment: boolean;
  startsNewCodedVideoSequence: boolean;
  /** Number of OBU elements, or zero when each element has a length prefix. */
  w?: 0 | 1 | 2 | 3;
}): Buffer {
  if (startsWithFragment && startsNewCodedVideoSequence) {
    throw new Error(
      "AV1 aggregation header: N=1 and Z=1 must not both be set (AV1 RTP §4.4)",
    );
  }
  // Z|Y|W|N|000
  return new BitWriter(8)
    .set(1, 0, startsWithFragment ? 1 : 0)
    .set(1, 1, endsWithFragment ? 1 : 0)
    .set(2, 2, w)
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

/** obu_type of a Sequence Header OBU (AV1 spec §6.2.2). */
const OBU_SEQUENCE_HEADER = 1;
/** obu_type of a Temporal Delimiter OBU; MUST NOT be sent over RTP (AV1 RTP §5). */
const OBU_TEMPORAL_DELIMITER = 2;

/**
 * Convert an OBU to its RTP element form: obu_has_size_field=0 and no LEB128
 * size (AV1 RTP §5: senders SHOULD clear it; libwebrtc cannot reassemble
 * fragments that still carry a size field).
 */
function toRtpObuElement(obu: Buffer): Buffer {
  const header = obu[0];
  if (!getBit(header, 6)) {
    return obu;
  }
  const headerLength = getBit(header, 5) ? 2 : 1;
  const [, sizeBytes] = leb128decode(obu.subarray(headerLength));
  const out = Buffer.concat([
    obu.subarray(0, headerLength),
    obu.subarray(headerLength + sizeBytes),
  ]);
  out[0] = header & ~0x02;
  return out;
}

/** temporal_id/spatial_id bits of the OBU extension header, if present. */
function getAv1ObuLayerId(obu: Buffer): number | undefined {
  if (!getBit(obu[0], 5) || obu.length < 2) return undefined;
  return obu[1] & 0xf8;
}

export type Av1PacketizerOptions = PacketizerBaseOptions & {
  /**
   * Default keyframe flag. Keyframe-ness alone does not set the N bit; see
   * {@link Av1PacketizeOptions.startsNewCodedVideoSequence}.
   * Override per call via packetize(..., { isKeyframe }).
   */
  isKeyframe?: boolean;
};

export type Av1PacketizeOptions = {
  /** Keyframe flag. Does NOT by itself set the N bit (see below). */
  isKeyframe?: boolean;
  frameType?: "key" | "delta";
  /**
   * N bit (RFC 9628 §4.4): first packet of a new coded video sequence.
   * A keyframe in the middle of a sequence must not set it. When omitted,
   * N is set only for a keyframe whose temporal unit contains a Sequence
   * Header OBU (a new coded video sequence cannot start without one); pass
   * `false` to force it off for in-band repeated headers, `true` to force on
   * (e.g. when the sequence header is carried out of band).
   */
  startsNewCodedVideoSequence?: boolean;
};

/**
 * Packetize one AV1 access unit (OBU sequence) into RTP packets.
 * Uses W=0 length-prefixed OBU elements, aggregates them to the MTU, and
 * fragments large OBUs with Z/Y bits.
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

    const allObus = splitAv1Obus(data);
    if (allObus.length === 0) {
      throw new Error("AV1 sample did not contain any OBU data");
    }

    const startsNewSequence =
      options.startsNewCodedVideoSequence ??
      (isKeyframe &&
        allObus.some((o) => ((o[0] >> 3) & 0x0f) === OBU_SEQUENCE_HEADER));

    const obus = allObus
      .filter((o) => ((o[0] >> 3) & 0x0f) !== OBU_TEMPORAL_DELIMITER)
      .map(toRtpObuElement);
    if (obus.length === 0) {
      return [];
    }

    // W=0 では全 OBU element に LEB128 長さ field が必要なので、
    // aggregation header + size + 1 byte の最低 3 byte を確保する。
    if (this.maxPayloadSize < 3) {
      throw new Error(
        `Av1Packetizer: maxPayloadSize ${this.maxPayloadSize} too small for aggregation header`,
      );
    }

    const packets: RtpPacket[] = [];
    let packetElements: Buffer[] = [];
    let packetSize = 1; // aggregation header
    let packetStartsWithFragment = false;
    let packetEndsWithFragment = false;
    // 同一 packet 内の拡張ヘッダ付き OBU は temporal_id/spatial_id が同一でなければならない。
    let packetLayerId: number | undefined;

    const flushPacket = () => {
      if (packetElements.length === 0) return;
      const aggregationHeader = createAv1AggregationHeader({
        startsWithFragment: packetStartsWithFragment,
        endsWithFragment: packetEndsWithFragment,
        startsNewCodedVideoSequence: packets.length === 0 && startsNewSequence,
        w: 0,
      });
      const payload = Buffer.concat([
        aggregationHeader,
        ...packetElements.flatMap((element) => [
          leb128encode(element.length),
          element,
        ]),
      ]);
      packets.push(this.buildPacket(payload, rtpTimestamp, false));
      packetElements = [];
      packetSize = 1;
      packetStartsWithFragment = false;
      packetEndsWithFragment = false;
      packetLayerId = undefined;
    };

    for (const obu of obus) {
      const layerId = getAv1ObuLayerId(obu);
      if (
        layerId !== undefined &&
        packetLayerId !== undefined &&
        layerId !== packetLayerId
      ) {
        flushPacket();
      }
      let offset = 0;
      let isContinuation = false;
      while (offset < obu.length) {
        const available = this.maxPayloadSize - packetSize;
        let chunkSize = Math.min(obu.length - offset, available);
        while (
          chunkSize > 0 &&
          chunkSize + leb128encode(chunkSize).length > available
        ) {
          chunkSize--;
        }
        if (chunkSize === 0) {
          // 残り容量に長さ field と OBU の 1 byte も入らないため packet を閉じる。
          if (packetElements.length > 0) {
            flushPacket();
            continue;
          }
          throw new Error(
            `Av1Packetizer: maxPayloadSize ${this.maxPayloadSize} cannot fit an OBU element`,
          );
        }

        if (packetElements.length === 0) {
          packetStartsWithFragment = isContinuation;
        }
        const end = offset + chunkSize;
        packetElements.push(obu.subarray(offset, end));
        if (layerId !== undefined) packetLayerId = layerId;
        packetSize += leb128encode(chunkSize).length + chunkSize;
        offset = end;
        packetEndsWithFragment = offset < obu.length;

        if (packetEndsWithFragment) {
          // OBU continuation は次 packet の先頭に続くため、ここで現在 packet を閉じる。
          flushPacket();
          isContinuation = true;
        } else {
          isContinuation = false;
        }
      }
    }
    flushPacket();

    // Marker on last packet of the frame (AV1 RTP marker bit semantics)
    packets.at(-1)!.header.marker = true;
    return packets;
  }
}
