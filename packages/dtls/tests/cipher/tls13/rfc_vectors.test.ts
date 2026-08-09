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
  TLS13_LABEL_PREFIX,
  emptyHashSha256,
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
 * Fixed-output vectors for DTLS 1.3 HKDF / Finished / exporter / AEAD.
 * Expected hex digests are pinned constants (not re-derived in the assertion)
 * so a broken HKDF/label/transcript implementation fails the suite.
 */
describe("tls13 RFC-structure deterministic vectors", () => {
  const secret0 = Buffer.alloc(32, 0x11);
  const ks = new Dtls13KeySchedule(DTLS13_LABEL_PREFIX);

  // Pinned: HKDF-Expand-Label(0x11*32, "dtls13"+label, "", L) via SHA-256
  const PINNED_KEY = "ed42c07a4495d8c4c75abc4f889c6155";
  const PINNED_IV = "679ac79b84b6d022c340ac85";
  const PINNED_SN = "e80e148f1e9bf1bc872e8dedf462da34";
  const PINNED_FINISHED_KEY =
    "c97c563e52fc4820e073e0f25ede2e9e02d694cd7ab27c68cfac25c238fa8116";
  const PINNED_VERIFY_DATA =
    "2bae073e4402209626259ab2a1587696e38d1ec5d41f0c5a768bbfde3a06d378";
  const PINNED_EXPORTER_60 =
    "a71afff3209b533c918c555b239a85b618655b646a78067f841472ec31ebb0702f7ccb539f69a389255363951361409a662b6a197758d647fcbbf675";
  // traffic_secret_N+1 = HKDF-Expand-Label(secret0, "dtls13traffic upd", "", 32)
  const PINNED_TRAFFIC_UPD =
    "6a4f97e87a35a583d1af794e1e4947eb8df3a10c131856f33b2609231d2ce0ea";

  test("HKDF-Expand-Label dtls13 key/iv/sn match pinned digests", () => {
    // Arrange / Act
    const key = hkdfExpandLabelManual(secret0, "key", Buffer.alloc(0), 16);
    const iv = hkdfExpandLabelManual(secret0, "iv", Buffer.alloc(0), 12);
    const sn = hkdfExpandLabelManual(secret0, "sn", Buffer.alloc(0), 16);
    // Assert: fixed vectors (not re-running the SUT for expected)
    expect(key.toString("hex")).toBe(PINNED_KEY);
    expect(iv.toString("hex")).toBe(PINNED_IV);
    expect(sn.toString("hex")).toBe(PINNED_SN);
    expect(key.equals(sn)).toBe(false);
  });

  test("Finished verify_data matches pinned TLS 1.3 / dtls13 construction", () => {
    // Arrange
    const transcript = Buffer.from(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "hex",
    );
    // Act
    const vd = ks.verifyData(secret0, transcript);
    const finKey = ks.finishedKey(secret0);
    // Assert: pinned finished key + verify_data (transcript hash path)
    expect(finKey.toString("hex")).toBe(PINNED_FINISHED_KEY);
    expect(vd.toString("hex")).toBe(PINNED_VERIFY_DATA);
    // Structure: HMAC(finished_key, Hash(transcript))
    expect(hmacSha256(finKey, hashSha256(transcript)).toString("hex")).toBe(
      PINNED_VERIFY_DATA,
    );
  });

  // Pinned binder / finished vectors (RFC 8446 structure; independent of SUT re-run)
  // Early Secret = HKDF-Extract(0, 0) with SHA-256; binder = Derive-Secret(ES, label, "")
  const PINNED_EARLY_SECRET =
    "33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a";
  const PINNED_EXT_BINDER_DTLS =
    "c3dedc65210ffcaea237a62deb2f1d0096c1ef6cc731eb6c2c848ad532b24f8f";
  const PINNED_RES_BINDER_DTLS =
    "81cd192620efec1413480b308cf853e8b855059a91bb52f20116df602846694e";
  const PINNED_BINDER_VD_DTLS =
    "cfaa1583596da7ca18cc866a1645c07ee7eb60b9f7579e5aa3a1af34ac9ca310";
  const PINNED_EXT_BINDER_TLS =
    "8fa31e7b3844748675c3a4728ba01c382ebd0c5f64cc6bee56c863982624c3e2";
  const PINNED_TLS_FINISHED_KEY =
    "8b093b35b9da43f00ec48f6cc2bba5d331540e476e74c45cfa1c5c82f1320b80";
  const PINNED_TLS_VERIFY_DATA =
    "cf35732e38830f8b7a4e9e2170b0187bc7db9cfb3b8f39436b3564442828efd3";

  test("binder_key ext/res match pinned Derive-Secret vectors (dtls13)", () => {
    // Arrange
    const early = ks.earlySecret();
    // Act
    const ext = ks.binderKey(early, false);
    const res = ks.binderKey(early, true);
    // Assert
    expect(early.toString("hex")).toBe(PINNED_EARLY_SECRET);
    expect(ext.toString("hex")).toBe(PINNED_EXT_BINDER_DTLS);
    expect(res.toString("hex")).toBe(PINNED_RES_BINDER_DTLS);
    // Structure: Derive-Secret uses Hash("") context
    const manualExt = hkdfExpandLabelManual(
      early,
      "ext binder",
      emptyHashSha256(),
      32,
      DTLS13_LABEL_PREFIX,
    );
    expect(manualExt.toString("hex")).toBe(PINNED_EXT_BINDER_DTLS);
  });

  test("binder verify_data uses finished construction on binder_key", () => {
    // Arrange
    const transcript = Buffer.from(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "hex",
    );
    const early = ks.earlySecret();
    const bk = ks.binderKey(early, false);
    // Act
    const vd = ks.binderVerifyData(bk, transcript);
    // Assert
    expect(vd.toString("hex")).toBe(PINNED_BINDER_VD_DTLS);
    expect(vd.equals(ks.verifyData(bk, transcript))).toBe(true);
  });

  test("TLS 1.3 label prefix binder + Finished match independent pinned vectors", () => {
    // Arrange: RFC 8446 uses "tls13 " prefix (contrast dtls13)
    const ksTls = new Dtls13KeySchedule(TLS13_LABEL_PREFIX);
    const transcript = Buffer.from(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "hex",
    );
    // Act
    const early = ksTls.earlySecret();
    const ext = ksTls.binderKey(early, false);
    const finKey = ksTls.finishedKey(secret0);
    const vd = ksTls.verifyData(secret0, transcript);
    // Assert
    expect(ext.toString("hex")).toBe(PINNED_EXT_BINDER_TLS);
    expect(finKey.toString("hex")).toBe(PINNED_TLS_FINISHED_KEY);
    expect(vd.toString("hex")).toBe(PINNED_TLS_VERIFY_DATA);
    // TLS finished key differs from dtls13 for same secret0
    expect(finKey.toString("hex")).not.toBe(PINNED_FINISHED_KEY);
  });

  test("EXTRACTOR-dtls_srtp exporter matches pinned 60-byte vector", () => {
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
    expect(out.toString("hex")).toBe(PINNED_EXPORTER_60);
  });

  test("KeyUpdate traffic upd secret matches pinned digest", () => {
    // Arrange / Act
    const next = ks.updateTrafficSecret(secret0);
    // Assert
    expect(next.toString("hex")).toBe(PINNED_TRAFFIC_UPD);
    expect(next.equals(secret0)).toBe(false);
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
    expect(nonce.toString("hex")).toBe("444444444444444444444443");
    expect(inner.contentType).toBe(23);
    expect(inner.content.toString()).toBe("app-payload");
    expect(ct.length).toBe(plaintext.length + 16);
    // Round-trip stability: same inputs → same ciphertext
    expect(
      encryptAes128Gcm(key, nonce, plaintext, header).toString("hex"),
    ).toBe(ct.toString("hex"));
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
