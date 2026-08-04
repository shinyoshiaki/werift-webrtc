// RFC 3640 — RTP Payload Format for Transport of MPEG-4 Elementary Streams
// AAC high bit-rate mode (mode=AAC-hbr), §3.3.6:
//   AU-header = AU-size (13 bit, size in octets — NOT size-1; ticket text was
//   incorrect on this point; RFC 3640 §3.2.1.1 / §3.3.6 is authoritative:
//   "AU-size: Indicates the size in octets", max 8191 = 2^13-1) + AU-Index (3 bit)
//   AU-headers-length is in bits and a multiple of 16 when headers are present.
// Fragmentation: first fragment carries AU Header Section (AU-size = full AU);
// subsequent fragments are raw AU data only (common non-interleaved practice;
// see also ticket constraint matching §3.2.3.1 marker-on-last rules).
// Registry name: MPEG4-GENERIC (SDP encoding name).

import type { RtpHeader, RtpPacket } from "../rtp/rtp";
import type { DePacketizerBase } from "./base";
import { PacketizerBase, type PacketizerBaseOptions } from "./base";

/** SDP encoding name for RFC 3640 mpeg4-generic. */
export const MPEG4_GENERIC_ENCODING_NAME = "MPEG4-GENERIC";

/** AAC-hbr default AU-header layout (RFC 3640 §3.3.6). */
export const AAC_HBR_SIZE_LENGTH = 13;
export const AAC_HBR_INDEX_LENGTH = 3;
export const AAC_HBR_INDEX_DELTA_LENGTH = 3;
export const AAC_HBR_AU_HEADER_BITS =
  AAC_HBR_SIZE_LENGTH + AAC_HBR_INDEX_LENGTH; // 16

/** Fragment accumulator prefix: 4-byte expected AU size (BE) + data. */
const FRAG_SIZE_PREFIX = 4;

export type AacHbrDepacketizerOptions = {
  /**
   * When true, after each AU-header the parser expects CTS-flag (1) and
   * optionally CTS-delta / DTS-flag / DTS-delta if flags are set.
   * Default false (minimal AAC-hbr: size + index only).
   */
  ctsDtsPresent?: boolean;
  ctsDeltaLength?: number;
  dtsDeltaLength?: number;
};

export type AuHeader = {
  /** Access Unit size in octets (RFC 3640 AU-size). */
  size: number;
  /** AU-Index (first) or AU-Index-delta (subsequent). */
  index: number;
  hasCts?: boolean;
  ctsDelta?: number;
  hasDts?: boolean;
  dtsDelta?: number;
};

/**
 * AAC-hbr RTP payload (RFC 3640 §3.3.6).
 * deSerialize validates AU-headers-length and AU sizes before concatenation.
 */
export class AacHbrRtpPayload implements DePacketizerBase {
  payload!: Buffer;
  fragment?: Buffer;
  auHeaders: AuHeader[] = [];
  isContinuationFragment = false;

  static deSerialize(buf: Buffer, fragment?: Buffer): AacHbrRtpPayload {
    const result = new AacHbrRtpPayload();

    // Continuation fragment: raw AU data only
    if (fragment && fragment.length >= FRAG_SIZE_PREFIX) {
      result.isContinuationFragment = true;
      const expected = fragment.readUInt32BE(0);
      const prev = fragment.subarray(FRAG_SIZE_PREFIX);
      if (prev.length > expected) {
        throw new Error(
          `AAC continuation: accumulated fragment already exceeds AU-size ${expected}`,
        );
      }
      const acc = Buffer.concat([prev, buf]);
      if (acc.length > expected) {
        // Strict: refuse silent truncation of surplus bytes
        throw new Error(
          `AAC continuation fragment exceeds AU-size: got ${acc.length}, expected ${expected}`,
        );
      }
      if (acc.length === expected) {
        result.payload = acc;
        result.fragment = undefined;
      } else {
        result.fragment = packFragment(expected, acc);
      }
      return result;
    }

    if (buf.length < 2) {
      throw new Error(
        `AAC AU Header Section too short: expected at least 2 bytes, got ${buf.length}`,
      );
    }

    // AU-headers-length is in bits (RFC 3640 §3.2.1)
    const auHeadersLengthBits = buf.readUInt16BE(0);
    if (auHeadersLengthBits < 16) {
      throw new Error(
        `AAC AU-headers-length too small: ${auHeadersLengthBits} bits (minimum 16 for hbr)`,
      );
    }
    if (auHeadersLengthBits % 16 !== 0) {
      throw new Error(
        `AAC AU-headers-length must be a multiple of 16, got ${auHeadersLengthBits}`,
      );
    }

    const auHeadersLengthBytes = Math.ceil(auHeadersLengthBits / 8);
    const headerSectionEnd = 2 + auHeadersLengthBytes;
    if (headerSectionEnd > buf.length) {
      throw new Error(
        `AAC AU Header Section exceeds buffer: need ${headerSectionEnd}, have ${buf.length}`,
      );
    }

    const headers = parseAuHeaders(
      buf.subarray(2, headerSectionEnd),
      auHeadersLengthBits,
    );
    result.auHeaders = headers;

    const dataSection = buf.subarray(headerSectionEnd);
    let totalSize = 0;
    for (const h of headers) {
      totalSize += h.size;
    }

    // Single AU fragment: AU-size is full size, data section is partial
    // RFC 3640 §3.2.1.1
    if (headers.length === 1 && dataSection.length < headers[0].size) {
      if (dataSection.length === 0) {
        throw new Error("AAC fragmented AU with empty data section");
      }
      result.fragment = packFragment(headers[0].size, dataSection);
      return result;
    }

    if (totalSize > dataSection.length) {
      throw new Error(
        `AAC AU sizes exceed data section: headers sum ${totalSize}, data ${dataSection.length}`,
      );
    }
    if (totalSize < dataSection.length) {
      throw new Error(
        `AAC data section has surplus bytes: headers sum ${totalSize}, data ${dataSection.length}`,
      );
    }

    if (headers.length === 1) {
      result.payload = Buffer.from(dataSection.subarray(0, headers[0].size));
    } else {
      const parts: Buffer[] = [];
      let offset = 0;
      for (const h of headers) {
        parts.push(dataSection.subarray(offset, offset + h.size));
        offset += h.size;
      }
      result.payload = Buffer.concat(parts);
    }

    return result;
  }

  static isDetectedFinalPacketInSequence(header: RtpHeader) {
    return header.marker;
  }

  get isKeyframe() {
    return true;
  }
}

function packFragment(expectedSize: number, data: Buffer): Buffer {
  const prefix = Buffer.alloc(FRAG_SIZE_PREFIX);
  prefix.writeUInt32BE(expectedSize, 0);
  return Buffer.concat([prefix, data]);
}

function parseAuHeaders(headerBytes: Buffer, lengthBits: number): AuHeader[] {
  const headers: AuHeader[] = [];
  let bitPos = 0;
  let isFirst = true;

  while (bitPos + AAC_HBR_AU_HEADER_BITS <= lengthBits) {
    const size = readBits(headerBytes, bitPos, AAC_HBR_SIZE_LENGTH);
    bitPos += AAC_HBR_SIZE_LENGTH;
    const index = readBits(
      headerBytes,
      bitPos,
      isFirst ? AAC_HBR_INDEX_LENGTH : AAC_HBR_INDEX_DELTA_LENGTH,
    );
    bitPos += isFirst ? AAC_HBR_INDEX_LENGTH : AAC_HBR_INDEX_DELTA_LENGTH;

    headers.push({ size, index });
    isFirst = false;
  }

  if (headers.length === 0) {
    throw new Error("AAC AU Header Section contained no AU-headers");
  }
  return headers;
}

/** Read `length` bits from `buf` starting at bit offset `bitPos` (MSB first). */
function readBits(buf: Buffer, bitPos: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    const absBit = bitPos + i;
    const byteIndex = absBit >> 3;
    const bitInByte = 7 - (absBit & 7);
    if (byteIndex >= buf.length) {
      throw new Error("AAC AU-header bit read past end of buffer");
    }
    const bit = (buf[byteIndex] >> bitInByte) & 1;
    value = (value << 1) | bit;
  }
  return value;
}

/** Write `length` bits of `value` into `buf` starting at bit offset `bitPos`. */
function writeBits(
  buf: Buffer,
  bitPos: number,
  length: number,
  value: number,
): void {
  for (let i = 0; i < length; i++) {
    const absBit = bitPos + i;
    const byteIndex = absBit >> 3;
    const bitInByte = 7 - (absBit & 7);
    const bit = (value >> (length - 1 - i)) & 1;
    if (bit) {
      buf[byteIndex] |= 1 << bitInByte;
    }
  }
}

export type AacHbrPacketizerOptions = PacketizerBaseOptions;

/**
 * AAC-hbr packetizer (RFC 3640 §3.3.6).
 * - One or more complete AUs with AU Header Section
 * - MTU-exceeding single AU is fragmented: first packet has AU headers
 *   (AU-size = full AU size); subsequent packets are raw fragment data
 */
export class AacHbrPacketizer extends PacketizerBase {
  constructor(options: AacHbrPacketizerOptions = {}) {
    super(options);
  }

  /**
   * Packetize one Access Unit (AAC frame).
   * For multiple AUs in one packet, use {@link packetizeAccessUnits}.
   */
  packetize(data: Buffer, rtpTimestamp: number): RtpPacket[] {
    return this.packetizeAccessUnits([data], rtpTimestamp);
  }

  packetizeAccessUnits(aus: Buffer[], rtpTimestamp: number): RtpPacket[] {
    if (aus.length === 0) {
      return [];
    }

    if (aus.length === 1) {
      return this.packetizeOneAu(aus[0], rtpTimestamp);
    }

    const headerBits = aus.length * AAC_HBR_AU_HEADER_BITS;
    const headerBytes = 2 + Math.ceil(headerBits / 8);
    const dataBytes = aus.reduce((n, a) => n + a.length, 0);
    if (headerBytes + dataBytes <= this.maxPayloadSize) {
      return [this.buildPacket(buildAuPayload(aus), rtpTimestamp, true)];
    }

    const packets: RtpPacket[] = [];
    for (const au of aus) {
      packets.push(...this.packetizeOneAu(au, rtpTimestamp));
    }
    return packets;
  }

  private packetizeOneAu(au: Buffer, rtpTimestamp: number): RtpPacket[] {
    const firstHeaderOverhead = 4; // 2 length + 2 AU-header
    const maxFirstData = this.maxPayloadSize - firstHeaderOverhead;

    if (maxFirstData <= 0) {
      throw new Error("invalid AAC RTP maxPayloadSize for fragmentation");
    }

    if (au.length <= maxFirstData) {
      return [this.buildPacket(buildAuPayload([au]), rtpTimestamp, true)];
    }

    // Fragmentation: first packet has AU Header Section, rest are raw
    // RFC 3640 §3.2.3.1 — marker on last fragment only
    const packets: RtpPacket[] = [];
    let offset = 0;

    const firstChunk = au.subarray(0, maxFirstData);
    packets.push(
      this.buildPacket(
        buildAuPayload([au], firstChunk),
        rtpTimestamp,
        firstChunk.length >= au.length,
      ),
    );
    offset = firstChunk.length;

    while (offset < au.length) {
      const chunk = au.subarray(
        offset,
        Math.min(au.length, offset + this.maxPayloadSize),
      );
      const isLast = offset + chunk.length >= au.length;
      packets.push(this.buildPacket(chunk, rtpTimestamp, isLast));
      offset += chunk.length;
    }

    return packets;
  }
}

/**
 * Build RTP payload with AU Header Section for one or more AUs.
 * If `dataOverride` is set (fragmentation), that buffer is used as the data
 * section while AU-size fields still describe the full AU sizes.
 */
function buildAuPayload(fullAus: Buffer[], dataOverride?: Buffer): Buffer {
  const headerBits = fullAus.length * AAC_HBR_AU_HEADER_BITS;
  const headerBytes = Math.ceil(headerBits / 8);
  const headers = Buffer.alloc(headerBytes);

  let bitPos = 0;
  fullAus.forEach((au, i) => {
    if (au.length > 8191) {
      throw new Error(
        `AAC AU size ${au.length} exceeds AAC-hbr maximum 8191 octets (RFC 3640 §3.3.6)`,
      );
    }
    writeBits(headers, bitPos, AAC_HBR_SIZE_LENGTH, au.length);
    bitPos += AAC_HBR_SIZE_LENGTH;
    writeBits(
      headers,
      bitPos,
      i === 0 ? AAC_HBR_INDEX_LENGTH : AAC_HBR_INDEX_DELTA_LENGTH,
      0,
    );
    bitPos += i === 0 ? AAC_HBR_INDEX_LENGTH : AAC_HBR_INDEX_DELTA_LENGTH;
  });

  const lengthField = Buffer.alloc(2);
  lengthField.writeUInt16BE(headerBits, 0);

  const data =
    dataOverride ??
    (fullAus.length === 1 ? fullAus[0] : Buffer.concat(fullAus));

  return Buffer.concat([lengthField, headers, data]);
}
