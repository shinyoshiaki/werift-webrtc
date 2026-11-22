/**
 * DTLS 1.3 unified header (RFC 9147 §4.1), CID not supported (C=0 only).
 *
 * Fixed bits: 001xxxxx
 * C=0 (no CID), S=0 (8-bit seq) or S=1 (16-bit seq), L=0/1, EE=epoch low 2 bits
 */

export const UNIFIED_HEADER_FIXED_MASK = 0xe0; // top 3 bits
export const UNIFIED_HEADER_FIXED_VALUE = 0x20; // 001
export const UNIFIED_HEADER_C_BIT = 0x10;
export const UNIFIED_HEADER_S_BIT = 0x08;
export const UNIFIED_HEADER_L_BIT = 0x04;
export const UNIFIED_HEADER_EPOCH_MASK = 0x03;

export interface UnifiedHeader {
  epochLowBits: number;
  sequenceNumber: number;
  sequenceLength: 1 | 2;
  length?: number;
  lengthPresent: boolean;
  /** Serialized header bytes as used for AAD */
  serialized: Buffer;
  headerLength: number;
}

export function isUnifiedHeader(firstByte: number): boolean {
  return (firstByte & UNIFIED_HEADER_FIXED_MASK) === UNIFIED_HEADER_FIXED_VALUE;
}

export function isCidPresent(firstByte: number): boolean {
  return (firstByte & UNIFIED_HEADER_C_BIT) !== 0;
}

/**
 * Serialize unified header with 16-bit sequence and explicit length (interop-friendly).
 */
export function serializeUnifiedHeader(
  epoch: number,
  sequenceNumber: number,
  ciphertextLength: number,
  options?: { seq16?: boolean; lengthPresent?: boolean },
): Buffer {
  const seq16 = options?.seq16 !== false;
  const lengthPresent = options?.lengthPresent !== false;
  let first = UNIFIED_HEADER_FIXED_VALUE;
  first |= epoch & UNIFIED_HEADER_EPOCH_MASK;
  if (seq16) first |= UNIFIED_HEADER_S_BIT;
  if (lengthPresent) first |= UNIFIED_HEADER_L_BIT;

  const seqLen = seq16 ? 2 : 1;
  const total = 1 + seqLen + (lengthPresent ? 2 : 0);
  const buf = Buffer.alloc(total);
  buf.writeUInt8(first, 0);
  if (seq16) {
    buf.writeUInt16BE(sequenceNumber & 0xffff, 1);
  } else {
    buf.writeUInt8(sequenceNumber & 0xff, 1);
  }
  if (lengthPresent) {
    buf.writeUInt16BE(ciphertextLength, 1 + seqLen);
  }
  return buf;
}

export function parseUnifiedHeader(
  data: Buffer,
): UnifiedHeader & { remaining: Buffer } {
  if (data.length < 1) {
    throw new Error("unified header: buffer too short");
  }
  const first = data[0];
  if (!isUnifiedHeader(first)) {
    throw new Error("not a DTLS 1.3 unified header");
  }
  if (isCidPresent(first)) {
    throw new Error("DTLS Connection ID (C=1) is not supported");
  }
  const seq16 = (first & UNIFIED_HEADER_S_BIT) !== 0;
  const lengthPresent = (first & UNIFIED_HEADER_L_BIT) !== 0;
  const epochLowBits = first & UNIFIED_HEADER_EPOCH_MASK;
  const seqLen = seq16 ? 2 : 1;
  const headerLen = 1 + seqLen + (lengthPresent ? 2 : 0);
  if (data.length < headerLen) {
    throw new Error("unified header: truncated");
  }
  let sequenceNumber: number;
  if (seq16) {
    sequenceNumber = data.readUInt16BE(1);
  } else {
    sequenceNumber = data.readUInt8(1);
  }
  let length: number | undefined;
  if (lengthPresent) {
    length = data.readUInt16BE(1 + seqLen);
  }
  const serialized = Buffer.from(data.subarray(0, headerLen));
  return {
    epochLowBits,
    sequenceNumber,
    sequenceLength: seq16 ? 2 : 1,
    length,
    lengthPresent,
    serialized,
    headerLength: headerLen,
    remaining: data.subarray(headerLen),
  };
}
