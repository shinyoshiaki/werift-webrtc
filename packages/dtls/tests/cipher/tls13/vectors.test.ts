import { randomBytes } from "crypto";
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
  emptyHashSha256,
  hashSha256,
  hkdfExpandLabelManual,
  hmacSha256,
} from "../../../src/cipher/tls13/hkdf";
import { Dtls13KeySchedule } from "../../../src/cipher/tls13/keySchedule";
import {
  cookieBinding,
  mintCookie,
  verifyCookie,
} from "../../../src/handshake/extensions/cookie";
import { DtlsAck } from "../../../src/handshake/message/tls13/ack";
import { ContentType } from "../../../src/record/const";
import { serializeUnifiedHeader } from "../../../src/record/v1_3/header";
import {
  createEpochProtection,
  decryptRecord,
  encryptRecord,
} from "../../../src/record/v1_3/record";

describe("tls13 deterministic vectors", () => {
  test("Finished verify_data is HMAC(finished_key, Hash(transcript))", () => {
    // Arrange: 前提を準備する
    const ks = new Dtls13KeySchedule(DTLS13_LABEL_PREFIX);
    const secret = Buffer.alloc(32, 0x42);
    const transcript = Buffer.from(
      "clienthello-serverhello-finished-transcript",
    );

    // Act: 暗号ベクトルを検証する
    const vd = ks.verifyData(secret, transcript);
    const finKey = ks.finishedKey(secret);
    const expected = hmacSha256(finKey, hashSha256(transcript));

    // Assert: 暗号ベクトルを検証する
    expect(vd.equals(expected)).toBe(true);
    expect(vd.length).toBe(32);
  });

  test("EXTRACTOR-dtls_srtp exporter is stable", () => {
    // Arrange: 前提を準備する
    const ks = new Dtls13KeySchedule();
    const exp = Buffer.alloc(32, 0x11);

    // Act: use_srtp/MKI を検証する
    const a = ks.exportKeyingMaterial(
      exp,
      "EXTRACTOR-dtls_srtp",
      Buffer.alloc(0),
      60,
    );
    const b = ks.exportKeyingMaterial(
      exp,
      "EXTRACTOR-dtls_srtp",
      Buffer.alloc(0),
      60,
    );

    // Assert: use_srtp/MKI を検証する
    expect(a.length).toBe(60);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(Buffer.alloc(60))).toBe(false);
  });

  test("record protection + sn encryption + replay", () => {
    // Arrange: 前提を準備する
    const keys = {
      key: Buffer.alloc(16, 0xaa),
      iv: Buffer.alloc(12, 0xbb),
      snKey: Buffer.alloc(16, 0xcc),
    };
    const writeEp = createEpochProtection(2);
    writeEp.writeKeys = keys;
    const readEp = createEpochProtection(2);
    readEp.readKeys = { ...keys };

    // Act: リプレイを検証する
    const wire = encryptRecord(
      Buffer.from("payload"),
      ContentType.handshake,
      writeEp,
    );
    const dec = decryptRecord(wire, () => readEp);

    // Assert: リプレイを検証する
    expect(dec!.content.toString()).toBe("payload");
    expect(dec!.contentType).toBe(ContentType.handshake);
    // リプレイ拒否
    expect(() => decryptRecord(wire, () => readEp)).toThrow(/replay/);
  });

  test("record number mask is invertible", () => {
    // Arrange: 前提を準備する
    const snKey = Buffer.alloc(16, 7);
    const ciphertext = Buffer.alloc(32, 9);
    const header = serializeUnifiedHeader(2, 0x1234, 32);
    const mask = recordNumberMask(snKey, ciphertext);

    // Act: 期待どおりの結果を検証する
    const masked = applyRecordNumberMask(header, mask);
    const unmasked = applyRecordNumberMask(masked, mask);

    // Assert: 期待どおりの結果を検証する
    expect(unmasked.equals(header)).toBe(true);
    expect(masked.equals(header)).toBe(false);
  });

  test("KeyUpdate traffic secret chain is deterministic", () => {
    // Arrange: 前提を準備する
    const ks = new Dtls13KeySchedule();
    const s = Buffer.alloc(32, 3);

    // Act: KeyUpdate を検証する
    const s1 = ks.updateTrafficSecret(s);
    const s2 = ks.updateTrafficSecret(s1);

    // Assert: KeyUpdate を検証する
    expect(s1.equals(s)).toBe(false);
    expect(s2.equals(s1)).toBe(false);
    expect(ks.updateTrafficSecret(s).equals(s1)).toBe(true);
  });

  test("ACK empty and non-empty serialize", () => {
    // Arrange: 前提を準備する
    const empty = new DtlsAck([]).serialize();
    const one = new DtlsAck([{ epoch: 3, sequenceNumber: 5 }]).serialize();

    // Assert: ACK 処理を検証する
    expect(empty.readUInt16BE(0)).toBe(0);
    expect(DtlsAck.deSerialize(one).recordNumbers[0]).toEqual({
      epoch: 3,
      sequenceNumber: 5,
    });
  });

  test("cookie mint/verify with binding", () => {
    // Arrange: 前提を準備する
    const secret = randomBytes(16);
    const binding = cookieBinding("127.0.0.1:1", Buffer.from("ch"));

    // Act: cookie 経路を検証する
    const cookie = mintCookie(secret, binding);
    // Assert: cookie 経路を検証する
    expect(verifyCookie(secret, cookie, binding)).toBe(true);
    expect(verifyCookie(secret, Buffer.alloc(32), binding)).toBe(false);
    expect(
      verifyCookie(
        secret,
        cookie,
        cookieBinding("9.9.9.9:9", Buffer.from("ch")),
      ),
    ).toBe(false);
  });

  test("nonce uses 64-bit sequence without epoch", () => {
    // Arrange: 前提を準備する
    const iv = Buffer.alloc(12, 0);
    // Act: epoch 管理を検証する
    const n0 = buildNonce(iv, 2, 0);
    const n1 = buildNonce(iv, 9, 1);
    // Assert: epoch 管理を検証する
    expect(n0.subarray(0, 4).equals(Buffer.alloc(4))).toBe(true);
    expect(sequenceToUInt64(1).readUIntBE(2, 6)).toBe(1);
    expect(n1[11]).toBe(1);
  });

  test("inner plaintext parse strips padding zeros", () => {
    // Arrange: 前提を準備する
    const inner = buildInnerPlaintext(Buffer.from("x"), 23, 3);
    // Act: codec の往復を検証する
    const parsed = parseInnerPlaintext(inner);
    // Assert: codec の往復を検証する
    expect(parsed.contentType).toBe(23);
    expect(parsed.content.toString()).toBe("x");
  });

  test("HKDF expand label length prefix", () => {
    // Arrange: 前提を準備する
    const secret = Buffer.alloc(32, 1);
    // Act: 暗号ベクトルを検証する
    const out = hkdfExpandLabelManual(
      secret,
      "key",
      Buffer.alloc(0),
      16,
      DTLS13_LABEL_PREFIX,
    );
    // Assert: 暗号ベクトルを検証する
    expect(out.length).toBe(16);
    expect(emptyHashSha256().length).toBe(32);
  });
});
