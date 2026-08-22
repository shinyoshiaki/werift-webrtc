import { createCipheriv, createDecipheriv } from "crypto";

/**
 * DTLS 1.3 record number encryption mask (RFC 9147 §4.2.3).
 * Mask = AES-ECB(sn_key, Ciphertext[0..15])
 */
export function recordNumberMask(snKey: Buffer, ciphertext: Buffer): Buffer {
  if (ciphertext.length < 16) {
    throw new Error("ciphertext too short for record number mask");
  }
  const block = ciphertext.subarray(0, 16);
  // AES-ECB encrypt single block (Node: aes-128-ecb)
  const cipher = createCipheriv("aes-128-ecb", snKey, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** XOR sequence number bytes in unified header with mask (S bit determines length). */
export function applyRecordNumberMask(header: Buffer, mask: Buffer): Buffer {
  const out = Buffer.from(header);
  const first = out[0];
  const seq16 = (first & 0x08) !== 0;
  const seqLen = seq16 ? 2 : 1;
  for (let i = 0; i < seqLen; i++) {
    out[1 + i] ^= mask[i];
  }
  return out;
}

/**
 * DTLS 1.3 AES-128-GCM record protection (RFC 9147 §4).
 * Nonce = write_iv XOR left-padded 64-bit (epoch||seq)
 * AAD = serialized ciphertext header (unified header as sent on wire)
 */

export const AES_128_GCM_TAG_LENGTH = 16;
export const AES_128_GCM_KEY_LENGTH = 16;
export const AES_128_GCM_IV_LENGTH = 12;

/**
 * Serialize 64-bit record sequence number (big-endian).
 * RFC 9147 §4: AEAD uses the 64-bit sequence_number only — epoch is NOT included
 * (unlike DTLS 1.2 AAD).
 */
export function sequenceToUInt64(sequenceNumber: number): Buffer {
  const buf = Buffer.alloc(8);
  // sequence numbers stay well below 2^53 in practice; write as big-endian u64
  const seq = BigInt(sequenceNumber) & 0xffffffffffffffffn;
  buf.writeBigUInt64BE(seq, 0);
  return buf;
}

/** @deprecated use sequenceToUInt64 — epoch is not part of DTLS 1.3 AEAD seq */
export function epochSequenceToUInt64(
  _epoch: number,
  sequenceNumber: number,
): Buffer {
  return sequenceToUInt64(sequenceNumber);
}

/**
 * DTLS 1.3 per-record nonce: XOR write_iv with left-padded 64-bit sequence.
 * Epoch is not mixed into the nonce (RFC 9147 §4).
 */
export function buildNonce(
  writeIv: Buffer,
  _epoch: number,
  sequenceNumber: number,
): Buffer {
  const seq = sequenceToUInt64(sequenceNumber);
  const nonce = Buffer.alloc(AES_128_GCM_IV_LENGTH);
  // left-pad seq to IV length then XOR
  const pad = AES_128_GCM_IV_LENGTH - 8;
  seq.copy(nonce, pad);
  for (let i = 0; i < AES_128_GCM_IV_LENGTH; i++) {
    nonce[i] ^= writeIv[i];
  }
  return nonce;
}

export function encryptAes128Gcm(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): Buffer {
  const cipher = createCipheriv("aes-128-gcm", key, nonce, {
    authTagLength: AES_128_GCM_TAG_LENGTH,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const head = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  return Buffer.concat([head, final, tag]);
}

export function decryptAes128Gcm(
  key: Buffer,
  nonce: Buffer,
  ciphertextWithTag: Buffer,
  aad: Buffer,
): Buffer {
  if (ciphertextWithTag.length < AES_128_GCM_TAG_LENGTH) {
    throw new Error("DTLS 1.3 ciphertext too short");
  }
  const encrypted = ciphertextWithTag.subarray(
    0,
    ciphertextWithTag.length - AES_128_GCM_TAG_LENGTH,
  );
  const tag = ciphertextWithTag.subarray(
    ciphertextWithTag.length - AES_128_GCM_TAG_LENGTH,
  );
  const decipher = createDecipheriv("aes-128-gcm", key, nonce, {
    authTagLength: AES_128_GCM_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  decipher.setAAD(aad, { plaintextLength: encrypted.length });
  const head = decipher.update(encrypted);
  const final = decipher.final();
  return final.length > 0 ? Buffer.concat([head, final]) : head;
}

/**
 * DTLSInnerPlaintext = content || type || zeros(padding)
 */
export function buildInnerPlaintext(
  content: Buffer,
  contentType: number,
  padding = 0,
): Buffer {
  const zeros = Buffer.alloc(padding);
  return Buffer.concat([content, Buffer.from([contentType]), zeros]);
}

/**
 * Strip trailing zeros and extract content type from DTLSInnerPlaintext.
 */
export function parseInnerPlaintext(inner: Buffer): {
  content: Buffer;
  contentType: number;
} {
  if (inner.length < 1) {
    throw new Error("empty DTLSInnerPlaintext");
  }
  let end = inner.length - 1;
  while (end >= 0 && inner[end] === 0) {
    end--;
  }
  if (end < 0) {
    throw new Error("DTLSInnerPlaintext has no content type");
  }
  const contentType = inner[end];
  const content = inner.subarray(0, end);
  return { content, contentType };
}
