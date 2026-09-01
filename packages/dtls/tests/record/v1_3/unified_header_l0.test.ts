import { describe, expect, test } from "vitest";
import { ContentType } from "../../../src/record/const";
import {
  isCidPresent,
  parseUnifiedHeader,
} from "../../../src/record/v1_3/header";
import {
  DTLS13_MAX_CIPHERTEXT_LENGTH,
  DtlsDecodeError,
  DtlsRecordOverflowError,
  createEpochProtection,
  decryptRecord,
  encryptRecord,
  parseDatagramRecords,
} from "../../../src/record/v1_3/record";

function arrangeEpochPair(epoch = 2) {
  const writeEp = createEpochProtection(epoch);
  writeEp.writeKeys = {
    key: Buffer.alloc(16, 1),
    iv: Buffer.alloc(12, 2),
    snKey: Buffer.alloc(16, 3),
  };
  const readEp = createEpochProtection(epoch);
  readEp.readKeys = {
    key: Buffer.alloc(16, 1),
    iv: Buffer.alloc(12, 2),
    snKey: Buffer.alloc(16, 3),
  };
  return { writeEp, readEp };
}

describe("DTLS 1.3 unified header L=0 receive (RFC 9147 §4.1)", () => {
  test("single encrypted handshake record L=0 decrypts and consumes the datagram", () => {
    // Arrange: L=0 ciphertext を合法に生成する
    const { writeEp, readEp } = arrangeEpochPair();
    const payload = Buffer.from("handshake-l0");
    const wire = encryptRecord(payload, ContentType.handshake, writeEp, {
      lengthPresent: false,
    });

    // Act: L=0 レコードを復号する
    const dec = decryptRecord(wire, () => readEp);

    // Assert: 残り全部を消費して handshake が取れる
    expect(dec).not.toBeNull();
    expect(dec!.contentType).toBe(ContentType.handshake);
    expect(dec!.content.equals(payload)).toBe(true);
    expect(dec!.consumed).toBe(wire.length);
    expect(parseUnifiedHeader(wire).lengthPresent).toBe(false);
  });

  test("single ACK record L=0 decrypts as ACK and consumes the datagram", () => {
    // Arrange: ACK を L=0 で暗号化
    const { writeEp, readEp } = arrangeEpochPair();
    const payload = Buffer.from([0x00, 0x00]);
    const wire = encryptRecord(payload, ContentType.ack, writeEp, {
      lengthPresent: false,
    });

    // Act: L=0 ACK を復号する
    const dec = decryptRecord(wire, () => readEp);

    // Assert: content type ACK、consumed が末尾
    expect(dec!.contentType).toBe(ContentType.ack);
    expect(dec!.content.equals(payload)).toBe(true);
    expect(dec!.consumed).toBe(wire.length);
  });

  test("application_data L=0 roundtrips payload", () => {
    // Arrange: アプリデータを L=0 で暗号化
    const { writeEp, readEp } = arrangeEpochPair(3);
    const payload = Buffer.from("app-l0-payload");
    const wire = encryptRecord(payload, ContentType.applicationData, writeEp, {
      lengthPresent: false,
    });

    // Act: 復号する
    const dec = decryptRecord(wire, () => readEp);

    // Assert: payload が一致する
    expect(dec!.contentType).toBe(ContentType.applicationData);
    expect(dec!.content.equals(payload)).toBe(true);
  });

  test("L=1 record followed by L=0 final record in the same datagram", () => {
    // Arrange: 同一 datagram に L=1 と末尾 L=0 を並べる
    const { writeEp, readEp } = arrangeEpochPair();
    const first = encryptRecord(
      Buffer.from("first-l1"),
      ContentType.handshake,
      writeEp,
    );
    const second = encryptRecord(
      Buffer.from("second-l0"),
      ContentType.handshake,
      writeEp,
      { lengthPresent: false },
    );
    const datagram = Buffer.concat([first, second]);

    // Act: 順にパースする
    const recs = parseDatagramRecords(datagram, () => readEp);

    // Assert: 途中の L=1 は length で切れ、最後が remainder
    expect(recs).toHaveLength(2);
    expect(recs[0]!.kind).toBe("ciphertext");
    expect(recs[1]!.kind).toBe("ciphertext");
    if (recs[0]!.kind === "ciphertext" && recs[1]!.kind === "ciphertext") {
      expect(recs[0].content.equals(Buffer.from("first-l1"))).toBe(true);
      expect(recs[1].content.equals(Buffer.from("second-l0"))).toBe(true);
    }
    expect(first.length + second.length).toBe(datagram.length);
  });

  test("truncated L=0 (header only / short ciphertext) is DtlsDecodeError", () => {
    // Arrange: L=0 ヘッダのみ、および ciphertext 不足
    const headerOnly = Buffer.from([0x2a, 0x00, 0x01]); // 001 + S=1 L=0 epoch 2
    const short = Buffer.concat([headerOnly, Buffer.alloc(8, 0xab)]);

    // Act / Assert: 切り詰めは decode_error
    expect(() => decryptRecord(headerOnly, () => undefined)).toThrow(
      DtlsDecodeError,
    );
    expect(() => decryptRecord(short, () => undefined)).toThrow(
      DtlsDecodeError,
    );
  });

  test("L=0 remainder above 16640 is DtlsRecordOverflowError", () => {
    // Arrange: L=0 で remainder が上限超過
    const header = Buffer.from([0x2a, 0x00, 0x01]);
    const over = Buffer.concat([
      header,
      Buffer.alloc(DTLS13_MAX_CIPHERTEXT_LENGTH + 1, 0x11),
    ]);

    // Act / Assert: record_overflow
    expect(() => decryptRecord(over, () => undefined)).toThrow(
      DtlsRecordOverflowError,
    );
  });

  test("CID=1 ciphertext is still rejected", () => {
    // Arrange: C=1 unified header
    const bad = Buffer.concat([
      Buffer.from([0x30, 0x00, 0x01, 0x00, 0x20]),
      Buffer.alloc(20),
    ]);

    // Act / Assert: CID は従来どおり拒否
    expect(isCidPresent(bad[0])).toBe(true);
    expect(() => decryptRecord(bad, () => undefined)).toThrow(/Connection ID/);
  });

  test("existing L=1 roundtrip still works", () => {
    // Arrange: 既定 L=1
    const { writeEp, readEp } = arrangeEpochPair();
    const payload = Buffer.from("still-l1");
    const wire = encryptRecord(payload, ContentType.handshake, writeEp);

    // Act: L=1 を復号する
    const dec = decryptRecord(wire, () => readEp);

    // Assert: 回帰なし
    expect(parseUnifiedHeader(wire).lengthPresent).toBe(true);
    expect(dec!.content.equals(payload)).toBe(true);
  });
});
