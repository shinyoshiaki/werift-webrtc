import { crc32 } from "../../imports/common";

import {
  DTLS_DEMUX_FIRST_BYTE_MAX,
  DTLS_DEMUX_FIRST_BYTE_MIN,
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
  SPED_ACK_MAX,
} from "./constants";
import type { SpedDecodedAck, SpedDecodedData } from "./types";

export function isDtlsHandshakeDemux(firstByte: number): boolean {
  return (
    firstByte >= DTLS_DEMUX_FIRST_BYTE_MIN &&
    firstByte <= DTLS_DEMUX_FIRST_BYTE_MAX
  );
}

export function encodeSpedData(value: Buffer): { type: number; value: Buffer } {
  return { type: DTLS_IN_STUN_DATA, value: Buffer.from(value) };
}

export function decodeSpedData(value: Buffer): SpedDecodedData {
  if (value.length === 0) {
    return { kind: "empty" };
  }
  if (!isDtlsHandshakeDemux(value[0])) {
    return { kind: "invalid-demux" };
  }
  return { kind: "datagram", bytes: Buffer.from(value) };
}

export function encodeSpedAck(crcs: readonly number[]): {
  type: number;
  value: Buffer;
} {
  const capped = crcs.slice(0, SPED_ACK_MAX);
  const value = Buffer.alloc(capped.length * 4);
  for (let i = 0; i < capped.length; i++) {
    value.writeUInt32BE(capped[i]! >>> 0, i * 4);
  }
  return { type: DTLS_IN_STUN_ACK, value };
}

/**
 * Decode DTLS-IN-STUN-ACK.
 * - length 0: empty ACK (legal)
 * - not a multiple of 4: ignore ACK attribute only
 * - more than 4 CRCs: take the first 4
 */
export function decodeSpedAck(value: Buffer): SpedDecodedAck {
  if (value.length === 0) {
    return { kind: "crcs", crcs: [] };
  }
  if (value.length % 4 !== 0) {
    return { kind: "ignore" };
  }
  const count = Math.min(value.length / 4, SPED_ACK_MAX);
  const crcs: number[] = [];
  for (let i = 0; i < count; i++) {
    crcs.push(value.readUInt32BE(i * 4) >>> 0);
  }
  return { kind: "crcs", crcs };
}

/** CRC-32 of the DATA attribute value only (no STUN padding, no Fingerprint XOR). */
export function spedDataCrc32(dataValue: Buffer): number {
  return crc32(dataValue) >>> 0;
}
