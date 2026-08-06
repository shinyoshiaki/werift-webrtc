import { createHash, createHmac, hkdfSync } from "crypto";

/**
 * DTLS 1.3 / TLS 1.3 HKDF helpers (RFC 8446 §7.1, RFC 9147).
 * Label prefix is "dtls13" for DTLS and "tls13 " for TLS.
 */

export const DTLS13_LABEL_PREFIX = "dtls13";
export const TLS13_LABEL_PREFIX = "tls13 ";

export function hashSha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  // HKDF-Extract(salt, IKM) = HMAC-Hash(salt, IKM)
  return hmacSha256(salt.length === 0 ? Buffer.alloc(32) : salt, ikm);
}

/**
 * HKDF-Expand-Label(Secret, Label, Context, Length)
 * HkdfLabel = length(2) || "dtls13"+Label || Context
 */
export function hkdfExpandLabel(
  secret: Buffer,
  label: string,
  context: Buffer,
  length: number,
  labelPrefix: string = DTLS13_LABEL_PREFIX,
): Buffer {
  const fullLabel = Buffer.from(labelPrefix + label, "ascii");
  const hkdfLabel = Buffer.alloc(2 + 1 + fullLabel.length + 1 + context.length);
  hkdfLabel.writeUInt16BE(length, 0);
  hkdfLabel.writeUInt8(fullLabel.length, 2);
  fullLabel.copy(hkdfLabel, 3);
  hkdfLabel.writeUInt8(context.length, 3 + fullLabel.length);
  context.copy(hkdfLabel, 4 + fullLabel.length);

  // HKDF-Expand(Secret, HkdfLabel, Length) via Node crypto
  return Buffer.from(
    hkdfSync("sha256", secret, Buffer.alloc(0), hkdfLabel, length),
  );
}

/**
 * Manual HKDF-Expand for environments where we need explicit control.
 * OKM = T(1) || T(2) || ... where T(i) = HMAC(PRK, T(i-1) || info || i)
 */
export function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const hashLen = 32;
  const n = Math.ceil(length / hashLen);
  const okm: Buffer[] = [];
  let prev: Buffer = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    prev = Buffer.from(
      hmacSha256(prk, Buffer.concat([prev, info, Buffer.from([i])])),
    );
    okm.push(prev);
  }
  return Buffer.concat(okm).subarray(0, length);
}

export function hkdfExpandLabelManual(
  secret: Buffer,
  label: string,
  context: Buffer,
  length: number,
  labelPrefix: string = DTLS13_LABEL_PREFIX,
): Buffer {
  const fullLabel = Buffer.from(labelPrefix + label, "ascii");
  const hkdfLabel = Buffer.alloc(2 + 1 + fullLabel.length + 1 + context.length);
  hkdfLabel.writeUInt16BE(length, 0);
  hkdfLabel.writeUInt8(fullLabel.length, 2);
  fullLabel.copy(hkdfLabel, 3);
  hkdfLabel.writeUInt8(context.length, 3 + fullLabel.length);
  context.copy(hkdfLabel, 4 + fullLabel.length);
  return hkdfExpand(secret, hkdfLabel, length);
}

export function deriveSecret(
  secret: Buffer,
  label: string,
  messages: Buffer,
  labelPrefix: string = DTLS13_LABEL_PREFIX,
): Buffer {
  const transcriptHash = hashSha256(messages);
  return hkdfExpandLabelManual(secret, label, transcriptHash, 32, labelPrefix);
}

export function emptyHashSha256(): Buffer {
  return hashSha256(Buffer.alloc(0));
}
