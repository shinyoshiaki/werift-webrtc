import {
  type AES_128_GCM_TAG_LENGTH,
  applyRecordNumberMask,
  buildInnerPlaintext,
  buildNonce,
  decryptAes128Gcm,
  encryptAes128Gcm,
  parseInnerPlaintext,
  recordNumberMask,
} from "../../cipher/tls13/aead";
import type { TrafficKeys } from "../../cipher/tls13/keySchedule";
import { AntiReplayWindow } from "../antiReplayWindow";
import { ContentType } from "../const";
import { DtlsPlaintext } from "../message/plaintext";
import {
  UNIFIED_HEADER_S_BIT,
  isCidPresent,
  isUnifiedHeader,
  parseUnifiedHeader,
  serializeUnifiedHeader,
} from "./header";

export const DTLS13_LEGACY_VERSION = { major: 254, minor: 253 }; // 0xfefd

/** Thrown when a ciphertext is discarded by anti-replay (not a fatal connection error). */
export class DtlsReplayError extends Error {
  readonly code = "replay";
  constructor(message: string) {
    super(message);
    this.name = "DtlsReplayError";
  }
}

export interface EpochProtection {
  epoch: number;
  readKeys?: TrafficKeys;
  writeKeys?: TrafficKeys;
  writeSequence: number;
  readReplay: AntiReplayWindow;
  /** For truncated sequence reconstruction */
  highestReadSeq: number;
}

export function createEpochProtection(epoch: number): EpochProtection {
  return {
    epoch,
    writeSequence: 0,
    readReplay: new AntiReplayWindow(),
    highestReadSeq: 0,
  };
}

/**
 * Encrypt content into a DTLS 1.3 unified ciphertext record.
 * Applies RFC 9147 record number encryption on the sequence field.
 */
export function encryptRecord(
  content: Buffer,
  contentType: number,
  epochState: EpochProtection,
): Buffer {
  if (!epochState.writeKeys) {
    throw new Error(`no write keys for epoch ${epochState.epoch}`);
  }
  const seq = epochState.writeSequence++;
  const inner = buildInnerPlaintext(content, contentType, 0);
  // Header length field covers encrypted_record length (ciphertext + tag)
  const ciphertextLength = inner.length + 16;
  // AAD uses the header with the *unencrypted* sequence number (RFC 9147)
  const headerPlain = serializeUnifiedHeader(
    epochState.epoch,
    seq,
    ciphertextLength,
  );
  const nonce = buildNonce(epochState.writeKeys.iv, epochState.epoch, seq);
  const encrypted = encryptAes128Gcm(
    epochState.writeKeys.key,
    nonce,
    inner,
    headerPlain,
  );
  // Encrypt sequence number field after ciphertext is known
  const mask = recordNumberMask(epochState.writeKeys.snKey, encrypted);
  const headerMasked = applyRecordNumberMask(headerPlain, mask);
  return Buffer.concat([headerMasked, encrypted]);
}

/**
 * Decrypt one DTLS 1.3 ciphertext record from buffer start.
 * Unmasks the encrypted sequence number (RFC 9147 §4.2.3) before AEAD.
 */
export function decryptRecord(
  data: Buffer,
  resolveEpoch: (epochLowBits: number) => EpochProtection | undefined,
): {
  content: Buffer;
  contentType: number;
  epoch: number;
  sequenceNumber: number;
  consumed: number;
} | null {
  if (data.length < 1) return null;
  if (!isUnifiedHeader(data[0])) {
    throw new Error("expected DTLS 1.3 unified ciphertext header");
  }
  if (isCidPresent(data[0])) {
    throw new Error("DTLS Connection ID (C=1) is not supported");
  }

  // Peek header layout without trusting encrypted sequence number
  const first = data[0];
  const seq16 = (first & UNIFIED_HEADER_S_BIT) !== 0;
  const lengthPresent = (first & 0x04) !== 0;
  const epochLowBits = first & 0x03;
  const seqLen = seq16 ? 2 : 1;
  const headerLen = 1 + seqLen + (lengthPresent ? 2 : 0);
  if (data.length < headerLen) return null;
  if (!lengthPresent) {
    throw new Error(
      "DTLS 1.3 records without length are not supported for receive",
    );
  }
  const length = data.readUInt16BE(1 + seqLen);
  const total = headerLen + length;
  if (data.length < total) return null;

  const epochState = resolveEpoch(epochLowBits);
  if (!epochState?.readKeys?.snKey) {
    throw new Error(`no read keys for epoch low bits ${epochLowBits}`);
  }

  const ciphertext = data.subarray(headerLen, total);
  // Unmask sequence number using first 16 ciphertext bytes
  const mask = recordNumberMask(epochState.readKeys.snKey, ciphertext);
  const headerMasked = data.subarray(0, headerLen);
  const headerPlain = applyRecordNumberMask(headerMasked, mask);
  const wireSeq = seq16
    ? headerPlain.readUInt16BE(1)
    : headerPlain.readUInt8(1);

  const seq = reconstructSequence(
    wireSeq,
    seq16 ? 2 : 1,
    epochState.highestReadSeq,
  );

  if (!epochState.readReplay.mayReceive(seq)) {
    throw new DtlsReplayError(`replay or too-old record seq=${seq}`);
  }

  // AAD is the header with the cleartext sequence number
  const nonce = buildNonce(epochState.readKeys.iv, epochState.epoch, seq);
  const inner = decryptAes128Gcm(
    epochState.readKeys.key,
    nonce,
    ciphertext,
    headerPlain,
  );
  const { content, contentType } = parseInnerPlaintext(inner);

  epochState.readReplay.markAsReceived(seq);
  if (seq > epochState.highestReadSeq) {
    epochState.highestReadSeq = seq;
  }

  return {
    content,
    contentType,
    epoch: epochState.epoch,
    sequenceNumber: seq,
    consumed: total,
  };
}

/**
 * Reconstruct full sequence number from truncated wire value.
 */
export function reconstructSequence(
  wireSeq: number,
  seqLen: 1 | 2,
  highestRead: number,
): number {
  const mask = seqLen === 2 ? 0xffff : 0xff;
  const window = seqLen === 2 ? 0x8000 : 0x80;
  // Start from highestRead neighborhood
  const base = highestRead & ~mask;
  let candidate = base + wireSeq;
  if (candidate + window < highestRead) {
    candidate += mask + 1;
  } else if (candidate > highestRead + window && base >= mask + 1) {
    candidate -= mask + 1;
  }
  return candidate;
}

/**
 * Epoch 0 DTLSPlaintext serialize (standard 13-byte header).
 */
export function serializePlaintextRecord(
  contentType: number,
  epoch: number,
  sequenceNumber: number,
  fragment: Buffer,
  protocolVersion = DTLS13_LEGACY_VERSION,
): Buffer {
  const pkt = new DtlsPlaintext(
    {
      contentType,
      protocolVersion,
      epoch,
      sequenceNumber,
      contentLen: fragment.length,
    },
    fragment,
  );
  return pkt.serialize();
}

export type ParsedPlaintextRecord = {
  kind: "plaintext";
  contentType: number;
  epoch: number;
  sequenceNumber: number;
  fragment: Buffer;
  consumed: number;
};

export type ParsedCiphertextRecord = {
  kind: "ciphertext";
  contentType: number;
  epoch: number;
  sequenceNumber: number;
  content: Buffer;
  consumed: number;
};

/**
 * Split one record from a datagram without requiring decryption keys for
 * subsequent records. Ciphertext is decrypted immediately using resolveEpoch
 * (caller must have installed keys from prior plaintext in the same flight).
 */
export function parseNextRecord(
  data: Buffer,
  resolveEpoch: (epochLowBits: number) => EpochProtection | undefined,
): ParsedPlaintextRecord | ParsedCiphertextRecord | null {
  if (data.length < 1) return null;
  const first = data[0];
  if (isUnifiedHeader(first)) {
    const dec = decryptRecord(data, resolveEpoch);
    if (!dec) return null;
    return {
      kind: "ciphertext",
      contentType: dec.contentType,
      epoch: dec.epoch,
      sequenceNumber: dec.sequenceNumber,
      content: dec.content,
      consumed: dec.consumed,
    };
  }
  if (first >= 20 && first <= 63) {
    if (data.length < 13) return null;
    const contentType = data.readUInt8(0);
    const epoch = data.readUInt16BE(3);
    const sequenceNumber = data.readUIntBE(5, 6);
    const contentLen = data.readUInt16BE(11);
    if (data.length < 13 + contentLen) return null;
    const fragment = Buffer.from(data.subarray(13, 13 + contentLen));
    return {
      kind: "plaintext",
      contentType,
      epoch,
      sequenceNumber,
      fragment,
      consumed: 13 + contentLen,
    };
  }
  throw new Error(`invalid DTLS record first byte 0x${first.toString(16)}`);
}

/**
 * Parse coalesced datagram. Processes sequentially so plaintext ServerHello
 * can install epoch-2 keys before following ciphertext in the same UDP packet
 * (required for BoringSSL interop).
 *
 * `onRecord` is invoked for each fully parsed record; it may install keys
 * as a side effect before the next record is decrypted.
 */
export function parseDatagramRecords(
  data: Buffer,
  resolveEpoch: (epochLowBits: number) => EpochProtection | undefined,
  onRecord?: (
    rec: ParsedPlaintextRecord | ParsedCiphertextRecord,
  ) => void | Promise<void>,
): Array<
  | {
      kind: "plaintext";
      contentType: number;
      epoch: number;
      sequenceNumber: number;
      fragment: Buffer;
    }
  | {
      kind: "ciphertext";
      contentType: number;
      epoch: number;
      sequenceNumber: number;
      content: Buffer;
    }
> {
  const out: Array<
    | {
        kind: "plaintext";
        contentType: number;
        epoch: number;
        sequenceNumber: number;
        fragment: Buffer;
      }
    | {
        kind: "ciphertext";
        contentType: number;
        epoch: number;
        sequenceNumber: number;
        content: Buffer;
      }
  > = [];
  let offset = 0;
  while (offset < data.length) {
    const rec = parseNextRecord(data.subarray(offset), resolveEpoch);
    if (!rec) break;
    offset += rec.consumed;
    if (rec.kind === "plaintext") {
      const item = {
        kind: "plaintext" as const,
        contentType: rec.contentType,
        epoch: rec.epoch,
        sequenceNumber: rec.sequenceNumber,
        fragment: rec.fragment,
      };
      out.push(item);
      onRecord?.(rec);
    } else {
      const item = {
        kind: "ciphertext" as const,
        contentType: rec.contentType,
        epoch: rec.epoch,
        sequenceNumber: rec.sequenceNumber,
        content: rec.content,
      };
      out.push(item);
      onRecord?.(rec);
    }
  }
  return out;
}

// silence unused type import if needed
export type { AES_128_GCM_TAG_LENGTH };
