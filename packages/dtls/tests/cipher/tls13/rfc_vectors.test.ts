import { describe, expect, test } from "vitest";
import {
  applyRecordNumberMask,
  buildInnerPlaintext,
  buildNonce,
  decryptAes128Gcm,
  encryptAes128Gcm,
  parseInnerPlaintext,
  recordNumberMask,
  sequenceToUInt64,
} from "../../../src/cipher/tls13/aead";
import {
  DTLS13_LABEL_PREFIX,
  hashSha256,
  hkdfExpandLabelManual,
  hmacSha256,
} from "../../../src/cipher/tls13/hkdf";
import { Dtls13KeySchedule } from "../../../src/cipher/tls13/keySchedule";
import { DtlsAck } from "../../../src/handshake/message/tls13/ack";
import { KeyUpdate } from "../../../src/handshake/message/tls13/keyUpdate";
import { ContentType } from "../../../src/record/const";
import { serializeUnifiedHeader } from "../../../src/record/v1_3/header";
import {
  createEpochProtection,
  decryptRecord,
  encryptRecord,
  reconstructSequence,
} from "../../../src/record/v1_3/record";

/**
 * Deterministic vectors for DTLS 1.3 record / ACK / replay / KeyUpdate / exporter.
 * Fixed seeds so regressions are byte-stable across runs (self-consistency + RFC structure).
 */
describe("tls13 RFC-structure deterministic vectors", () => {
  const secret0 = Buffer.alloc(32, 0x11);
  const ks = new Dtls13KeySchedule(DTLS13_LABEL_PREFIX);

  test("HKDF-Expand-Label dtls13 key/iv/sn are distinct fixed digests", () => {
    // Arrange / Act
    const key = hkdfExpandLabelManual(secret0, "key", Buffer.alloc(0), 16);
    const iv = hkdfExpandLabelManual(secret0, "iv", Buffer.alloc(0), 12);
    const sn = hkdfExpandLabelManual(secret0, "sn", Buffer.alloc(0), 16);
    // Assert: lengths and mutual inequality (label separation)
    expect(key.toString("hex")).toBe(
      hkdfExpandLabelManual(secret0, "key", Buffer.alloc(0), 16).toString(
        "hex",
      ),
    );
    expect(key.length).toBe(16);
    expect(iv.length).toBe(12);
    expect(sn.length).toBe(16);
    expect(key.equals(sn)).toBe(false);
    expect(key.subarray(0, 12).equals(iv)).toBe(false);
  });

  test("Finished verify_data matches TLS 1.3 construction with dtls13 finished key", () => {
    // Arrange
    const transcript = Buffer.from(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "hex",
    );
    // Act
    const vd = ks.verifyData(secret0, transcript);
    const finKey = ks.finishedKey(secret0);
    const expected = hmacSha256(finKey, hashSha256(transcript));
    // Assert
    expect(vd.equals(expected)).toBe(true);
    expect(vd.toString("hex")).toBe(expected.toString("hex"));
  });

  test("EXTRACTOR-dtls_srtp exporter is stable and non-zero", () => {
    // Arrange
    const expMaster = Buffer.alloc(32, 0x22);
    // Act
    const out = ks.exportKeyingMaterial(
      expMaster,
      "EXTRACTOR-dtls_srtp",
      Buffer.alloc(0),
      60,
    );
    // Assert
    expect(out.length).toBe(60);
    expect(out.equals(Buffer.alloc(60))).toBe(false);
    expect(
      ks
        .exportKeyingMaterial(
          expMaster,
          "EXTRACTOR-dtls_srtp",
          Buffer.alloc(0),
          60,
        )
        .equals(out),
    ).toBe(true);
  });

  test("AEAD encrypt/decrypt with known key/iv/seq (record protection)", () => {
    // Arrange
    const key = Buffer.alloc(16, 0x33);
    const iv = Buffer.alloc(12, 0x44);
    const seq = 7;
    const epoch = 2;
    const plaintext = buildInnerPlaintext(Buffer.from("app-payload"), 23, 0);
    const header = serializeUnifiedHeader(epoch, seq, plaintext.length + 16);
    const nonce = buildNonce(iv, epoch, seq);
    // Act
    const ct = encryptAes128Gcm(key, nonce, plaintext, header);
    const pt = decryptAes128Gcm(key, nonce, ct, header);
    const inner = parseInnerPlaintext(pt);
    // Assert
    expect(inner.contentType).toBe(23);
    expect(inner.content.toString()).toBe("app-payload");
    expect(ct.length).toBe(plaintext.length + 16);
  });

  test("record number encryption mask is involution", () => {
    // Arrange
    const snKey = Buffer.alloc(16, 0x55);
    const ciphertext = Buffer.alloc(32, 0x66);
    const header = serializeUnifiedHeader(2, 0xabcd, 32);
    const mask = recordNumberMask(snKey, ciphertext);
    // Act
    const masked = applyRecordNumberMask(header, mask);
    const unmasked = applyRecordNumberMask(masked, mask);
    // Assert
    expect(unmasked.equals(header)).toBe(true);
    expect(masked.equals(header)).toBe(false);
  });

  test("unified record encrypt/decrypt + replay rejection", () => {
    // Arrange
    const keys = {
      key: Buffer.alloc(16, 0x77),
      iv: Buffer.alloc(12, 0x88),
      snKey: Buffer.alloc(16, 0x99),
    };
    const w = createEpochProtection(2);
    w.writeKeys = keys;
    const r = createEpochProtection(2);
    r.readKeys = { ...keys };
    // Act
    const wire = encryptRecord(Buffer.from("rec"), ContentType.handshake, w);
    const d1 = decryptRecord(wire, () => r);
    // Assert
    expect(d1!.content.toString()).toBe("rec");
    expect(d1!.sequenceNumber).toBe(0);
    expect(() => decryptRecord(wire, () => r)).toThrow(/replay/);
  });

  test("sequence reconstruction for 16-bit truncated seq", () => {
    // Arrange / Act / Assert
    expect(reconstructSequence(0, 2, 0)).toBe(0);
    expect(reconstructSequence(1, 2, 0)).toBe(1);
    expect(reconstructSequence(0xffff, 2, 0xfffe)).toBe(0xffff);
  });

  test("ACK serialize/deSerialize empty and multi record numbers", () => {
    // Arrange
    const empty = new DtlsAck([]);
    const multi = new DtlsAck([
      { epoch: 2, sequenceNumber: 0 },
      { epoch: 2, sequenceNumber: 3 },
      { epoch: 3, sequenceNumber: 1 },
    ]);
    // Act
    const e = DtlsAck.deSerialize(empty.serialize());
    const m = DtlsAck.deSerialize(multi.serialize());
    // Assert
    expect(e.recordNumbers).toEqual([]);
    expect(m.recordNumbers).toEqual(multi.recordNumbers);
    // empty ACK has uint16 length 0
    expect(empty.serialize().readUInt16BE(0)).toBe(0);
  });

  test("KeyUpdate wire codec and traffic secret chain", () => {
    // Arrange
    const ku0 = new KeyUpdate(false);
    const ku1 = new KeyUpdate(true);
    // Act
    const round0 = KeyUpdate.deSerialize(ku0.serialize());
    const round1 = KeyUpdate.deSerialize(ku1.serialize());
    const s1 = ks.updateTrafficSecret(secret0);
    const s2 = ks.updateTrafficSecret(s1);
    // Assert
    expect(round0.requestUpdate).toBe(false);
    expect(round1.requestUpdate).toBe(true);
    expect(s1.equals(secret0)).toBe(false);
    expect(s2.equals(s1)).toBe(false);
    expect(ks.updateTrafficSecret(secret0).equals(s1)).toBe(true);
  });

  test("nonce uses 64-bit sequence only (epoch not mixed into AEAD seq)", () => {
    // Arrange
    const iv = Buffer.alloc(12, 0);
    // Act
    const n0 = buildNonce(iv, 2, 0);
    const n1 = buildNonce(iv, 9, 1);
    // Assert
    expect(sequenceToUInt64(1).readBigUInt64BE(0)).toBe(1n);
    expect(n0.every((b) => b === 0)).toBe(true);
    expect(n1[11]).toBe(1);
    // different epochs same seq → same nonce base xor
    expect(buildNonce(iv, 2, 5).equals(buildNonce(iv, 99, 5))).toBe(true);
  });
});
