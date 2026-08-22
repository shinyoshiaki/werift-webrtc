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

/**
 * RFC 8446 / RFC 9147 record size limits (TLS 1.3 plaintext / ciphertext).
 * Plaintext fragment ≤ 2^14; ciphertext expansion allows +256 bytes.
 */
export const DTLS13_MAX_PLAINTEXT_LENGTH = 1 << 14; // 16384
export const DTLS13_MAX_CIPHERTEXT_LENGTH = DTLS13_MAX_PLAINTEXT_LENGTH + 256; // 16640

/** Thrown when a ciphertext is discarded by anti-replay (not a fatal connection error). */
export class DtlsReplayError extends Error {
  readonly code = "replay";
  constructor(
    message: string,
    public readonly epoch = 0,
    public readonly sequenceNumber = 0,
    public readonly consumed = 0,
    /** Content type after successful AEAD (for handshake-only re-ACK). */
    public readonly contentType = 0,
  ) {
    super(message);
    this.name = "DtlsReplayError";
  }
}

/** Truncated or malformed DTLS record / handshake framing. */
export class DtlsDecodeError extends Error {
  readonly code = "decode";
  constructor(message: string) {
    super(message);
    this.name = "DtlsDecodeError";
  }
}

/**
 * Record exceeds TLS 1.3 / DTLS 1.3 length limits (alert record_overflow).
 * Visible in the header before AEAD for length-present ciphertext.
 */
export class DtlsRecordOverflowError extends Error {
  readonly code = "record_overflow";
  readonly alertDescription = 22; // AlertDesc.RecordOverflow
  constructor(message: string) {
    super(message);
    this.name = "DtlsRecordOverflowError";
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
  // RFC 8446 §5.1: plaintext fragment MUST NOT exceed 2^14 bytes
  if (content.length > DTLS13_MAX_PLAINTEXT_LENGTH) {
    throw new DtlsRecordOverflowError(
      `record_overflow: plaintext ${content.length} exceeds ${DTLS13_MAX_PLAINTEXT_LENGTH}`,
    );
  }
  const seq = epochState.writeSequence++;
  const inner = buildInnerPlaintext(content, contentType, 0);
  // Header length field covers encrypted_record length (ciphertext + tag)
  const ciphertextLength = inner.length + 16;
  if (ciphertextLength > DTLS13_MAX_CIPHERTEXT_LENGTH) {
    throw new DtlsRecordOverflowError(
      `record_overflow: ciphertext ${ciphertextLength} exceeds ${DTLS13_MAX_CIPHERTEXT_LENGTH}`,
    );
  }
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
 * Resolve epoch(s) for 2-bit wire epoch. May return one or many candidates
 * for trial decryption when KeyUpdate wraps the low bits.
 */
export type EpochResolver =
  | ((epochLowBits: number) => EpochProtection | undefined)
  | ((epochLowBits: number) => EpochProtection[]);

function epochCandidates(
  resolveEpoch: EpochResolver,
  epochLowBits: number,
): EpochProtection[] {
  const r = resolveEpoch(epochLowBits);
  if (!r) return [];
  return Array.isArray(r) ? r : [r];
}

/**
 * Decrypt one DTLS 1.3 ciphertext record from buffer start.
 * Unmasks the encrypted sequence number (RFC 9147 §4.2.3) before AEAD.
 * Tries every epoch candidate matching the 2-bit epoch field (KeyUpdate wrap).
 */
export function decryptRecord(
  data: Buffer,
  resolveEpoch: EpochResolver,
): {
  content: Buffer;
  contentType: number;
  epoch: number;
  sequenceNumber: number;
  consumed: number;
} | null {
  if (data.length < 1) {
    throw new DtlsDecodeError("ciphertext record: empty buffer");
  }
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
  if (data.length < headerLen) {
    throw new DtlsDecodeError(
      `ciphertext record truncated: need header ${headerLen}, have ${data.length}`,
    );
  }
  if (!lengthPresent) {
    throw new Error(
      "DTLS 1.3 records without length are not supported for receive",
    );
  }
  const length = data.readUInt16BE(1 + seqLen);
  // RFC 8446 §5.2: ciphertext length MUST NOT exceed 2^14 + 256
  if (length > DTLS13_MAX_CIPHERTEXT_LENGTH) {
    throw new DtlsRecordOverflowError(
      `record_overflow: ciphertext length ${length} exceeds ${DTLS13_MAX_CIPHERTEXT_LENGTH}`,
    );
  }
  const total = headerLen + length;
  if (data.length < total) {
    throw new DtlsDecodeError(
      `ciphertext record truncated: need ${total}, have ${data.length}`,
    );
  }

  const candidates = epochCandidates(resolveEpoch, epochLowBits).filter(
    (ep) => ep.readKeys?.snKey && ep.readKeys?.key && ep.readKeys?.iv,
  );
  if (candidates.length === 0) {
    throw new Error(`no read keys for epoch low bits ${epochLowBits}`);
  }

  const ciphertext = data.subarray(headerLen, total);
  const headerMasked = data.subarray(0, headerLen);
  let lastAeadError: Error | undefined;

  // Newest first, but try all on AEAD failure (epoch 3 vs 7 collision)
  const ordered = [...candidates].sort((a, b) => b.epoch - a.epoch);
  for (const epochState of ordered) {
    try {
      const mask = recordNumberMask(epochState.readKeys!.snKey, ciphertext);
      const headerPlain = applyRecordNumberMask(headerMasked, mask);
      const wireSeq = seq16
        ? headerPlain.readUInt16BE(1)
        : headerPlain.readUInt8(1);

      const seq = reconstructSequence(
        wireSeq,
        seq16 ? 2 : 1,
        epochState.highestReadSeq,
      );

      // AEAD first so wrong-key candidates fail cleanly before replay bookkeeping
      const nonce = buildNonce(epochState.readKeys!.iv, epochState.epoch, seq);
      const inner = decryptAes128Gcm(
        epochState.readKeys!.key,
        nonce,
        ciphertext,
        headerPlain,
      );
      const { content, contentType } = parseInnerPlaintext(inner);
      // RFC 8446 §5.4: plaintext after deprotection MUST NOT exceed 2^14
      if (content.length > DTLS13_MAX_PLAINTEXT_LENGTH) {
        throw new DtlsRecordOverflowError(
          `record_overflow: deprotected plaintext ${content.length} exceeds ${DTLS13_MAX_PLAINTEXT_LENGTH}`,
        );
      }

      if (!epochState.readReplay.mayReceive(seq)) {
        throw new DtlsReplayError(
          `replay or too-old record seq=${seq}`,
          epochState.epoch,
          seq,
          total,
          contentType,
        );
      }

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
    } catch (e) {
      if (
        e instanceof DtlsReplayError ||
        (e as Error)?.name === "DtlsReplayError"
      ) {
        throw e;
      }
      lastAeadError = e instanceof Error ? e : new Error(String(e));
      // try next epoch candidate
    }
  }

  throw (
    lastAeadError ??
    new Error(`decrypt failed for epoch low bits ${epochLowBits}`)
  );
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
  if (fragment.length > DTLS13_MAX_PLAINTEXT_LENGTH) {
    throw new DtlsRecordOverflowError(
      `record_overflow: plaintext fragment ${fragment.length} exceeds ${DTLS13_MAX_PLAINTEXT_LENGTH}`,
    );
  }
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
  resolveEpoch: EpochResolver,
): ParsedPlaintextRecord | ParsedCiphertextRecord | null {
  if (data.length < 1) return null;
  const first = data[0];
  if (isUnifiedHeader(first)) {
    const dec = decryptRecord(data, resolveEpoch);
    if (!dec) {
      throw new DtlsDecodeError("ciphertext decrypt returned empty");
    }
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
    if (data.length < 13) {
      throw new DtlsDecodeError(
        `plaintext record truncated: need 13-byte header, have ${data.length}`,
      );
    }
    const contentType = data.readUInt8(0);
    const epoch = data.readUInt16BE(3);
    const sequenceNumber = data.readUIntBE(5, 6);
    const contentLen = data.readUInt16BE(11);
    if (contentLen > DTLS13_MAX_PLAINTEXT_LENGTH) {
      throw new DtlsRecordOverflowError(
        `record_overflow: plaintext length ${contentLen} exceeds ${DTLS13_MAX_PLAINTEXT_LENGTH}`,
      );
    }
    if (data.length < 13 + contentLen) {
      throw new DtlsDecodeError(
        `plaintext record truncated: need ${13 + contentLen}, have ${data.length}`,
      );
    }
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
  throw new DtlsDecodeError(
    `invalid DTLS record first byte 0x${first.toString(16)}`,
  );
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
  resolveEpoch: EpochResolver,
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
