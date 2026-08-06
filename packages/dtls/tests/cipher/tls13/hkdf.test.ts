import { describe, expect, test } from "vitest";
import {
  buildInnerPlaintext,
  buildNonce,
  decryptAes128Gcm,
  encryptAes128Gcm,
  parseInnerPlaintext,
  sequenceToUInt64,
} from "../../../src/cipher/tls13/aead";
import {
  DTLS13_LABEL_PREFIX,
  emptyHashSha256,
  hashSha256,
  hkdfExpandLabelManual,
  hkdfExtract,
  hmacSha256,
} from "../../../src/cipher/tls13/hkdf";
import { Dtls13KeySchedule } from "../../../src/cipher/tls13/keySchedule";

describe("cipher/tls13/hkdf", () => {
  test("HKDF-Extract empty IKM uses Hash.length zeros", () => {
    // Arrange
    const salt = Buffer.alloc(32);
    const ikm = Buffer.alloc(32);

    // Act
    const prk = hkdfExtract(salt, ikm);

    // Assert: 安定した 32 バイト PRK
    expect(prk.length).toBe(32);
  });

  test("HKDF-Expand-Label uses dtls13 prefix", () => {
    // Arrange
    const secret = Buffer.alloc(32, 1);
    const label = "key";
    const context = Buffer.alloc(0);

    // Act
    const key = hkdfExpandLabelManual(
      secret,
      label,
      context,
      16,
      DTLS13_LABEL_PREFIX,
    );
    const keyTls = hkdfExpandLabelManual(secret, label, context, 16, "tls13 ");

    // Assert: DTLS と TLS の label prefix で結果が異なる
    expect(key.length).toBe(16);
    expect(key.equals(keyTls)).toBe(false);
  });

  test("empty Hash is SHA-256 of empty input", () => {
    // Arrange / Act
    const h = emptyHashSha256();

    // Assert
    expect(h.equals(hashSha256(Buffer.alloc(0)))).toBe(true);
    expect(h.toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("Finished verify_data is HMAC of transcript hash", () => {
    // Arrange
    const ks = new Dtls13KeySchedule(DTLS13_LABEL_PREFIX);
    const baseKey = Buffer.alloc(32, 0xab);
    const transcript = Buffer.from("hello-transcript");

    // Act
    const vd = ks.verifyData(baseKey, transcript);
    const finishedKey = ks.finishedKey(baseKey);
    const expected = hmacSha256(finishedKey, hashSha256(transcript));

    // Assert
    expect(vd.equals(expected)).toBe(true);
    expect(vd.length).toBe(32);
  });

  test("traffic secret update is deterministic", () => {
    // Arrange
    const ks = new Dtls13KeySchedule();
    const secret = Buffer.alloc(32, 7);

    // Act
    const next1 = ks.updateTrafficSecret(secret);
    const next2 = ks.updateTrafficSecret(secret);

    // Assert
    expect(next1.equals(next2)).toBe(true);
    expect(next1.equals(secret)).toBe(false);
  });

  test("exporter EXTRACTOR-dtls_srtp is deterministic", () => {
    // Arrange
    const ks = new Dtls13KeySchedule();
    const expMaster = Buffer.alloc(32, 9);

    // Act
    const a = ks.exportKeyingMaterial(
      expMaster,
      "EXTRACTOR-dtls_srtp",
      Buffer.alloc(0),
      60,
    );
    const b = ks.exportKeyingMaterial(
      expMaster,
      "EXTRACTOR-dtls_srtp",
      Buffer.alloc(0),
      60,
    );

    // Assert
    expect(a.length).toBe(60);
    expect(a.equals(b)).toBe(true);
  });
});

describe("cipher/tls13/aead", () => {
  test("encrypt/decrypt roundtrip with DTLS 1.3 nonce/AAD", () => {
    // Arrange
    const key = Buffer.alloc(16, 0x11);
    const iv = Buffer.alloc(12, 0x22);
    const epoch = 2;
    const seq = 7;
    const nonce = buildNonce(iv, epoch, seq);
    const plaintext = buildInnerPlaintext(Buffer.from("ping"), 23, 0);
    const aad = Buffer.from([0x2f, 0x00, 0x07, 0x00, plaintext.length + 16]);

    // Act
    const ct = encryptAes128Gcm(key, nonce, plaintext, aad);
    const pt = decryptAes128Gcm(key, nonce, ct, aad);
    const inner = parseInnerPlaintext(pt);

    // Assert
    expect(inner.contentType).toBe(23);
    expect(inner.content.toString()).toBe("ping");
  });

  test("sequenceToUInt64 is big-endian 64-bit sequence only", () => {
    // Arrange / Act
    const buf = sequenceToUInt64(0x010203040506);

    // Assert: epoch は含めない（上位は 0）
    expect(buf.readUInt16BE(0)).toBe(0);
    expect(buf.readUIntBE(2, 6)).toBe(0x010203040506);
  });
});
