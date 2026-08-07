import { describe, expect, test } from "vitest";
import { ContentType } from "../../../src/record/const";
import {
  isCidPresent,
  isUnifiedHeader,
  parseUnifiedHeader,
  serializeUnifiedHeader,
} from "../../../src/record/v1_3/header";
import {
  DtlsDecodeError,
  createEpochProtection,
  decryptRecord,
  encryptRecord,
  parseNextRecord,
  reconstructSequence,
} from "../../../src/record/v1_3/record";

describe("record/v1_3/header", () => {
  test("serialize and parse unified header with length", () => {
    // Arrange
    const header = serializeUnifiedHeader(2, 0x1234, 50);

    // Act
    const parsed = parseUnifiedHeader(
      Buffer.concat([header, Buffer.alloc(50)]),
    );

    // Assert
    expect(isUnifiedHeader(header[0])).toBe(true);
    expect(parsed.epochLowBits).toBe(2);
    expect(parsed.sequenceNumber).toBe(0x1234);
    expect(parsed.length).toBe(50);
    expect(parsed.headerLength).toBe(header.length);
  });

  test("CID=1 is rejected", () => {
    // Arrange
    const bad = Buffer.from([0x30, 0x00, 0x01, 0x00, 0x10]); // C bit set

    // Act / Assert
    expect(isCidPresent(bad[0])).toBe(true);
    expect(() => parseUnifiedHeader(bad)).toThrow(/Connection ID/);
  });

  test("encrypt/decrypt record roundtrip with anti-replay", () => {
    // Arrange
    const writeEp = createEpochProtection(2);
    writeEp.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const readEp = createEpochProtection(2);
    readEp.readKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const payload = Buffer.from("handshake-body");

    // Act
    const wire = encryptRecord(payload, ContentType.handshake, writeEp);
    const dec = decryptRecord(wire, () => readEp);

    // Assert
    expect(dec).not.toBeNull();
    expect(dec!.contentType).toBe(ContentType.handshake);
    expect(dec!.content.equals(payload)).toBe(true);

    // 再送はリプレイとして拒否
    expect(() => decryptRecord(wire, () => readEp)).toThrow(/replay/);
  });

  test("trial decrypt tries multiple epochs sharing low 2 bits", () => {
    // Arrange: epoch 3 and 7 both match low bits 3; only epoch 3 has the right key
    const writeEp = createEpochProtection(3);
    writeEp.writeKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const correct = createEpochProtection(3);
    correct.readKeys = {
      key: Buffer.alloc(16, 1),
      iv: Buffer.alloc(12, 2),
      snKey: Buffer.alloc(16, 3),
    };
    const wrongNewer = createEpochProtection(7);
    wrongNewer.readKeys = {
      key: Buffer.alloc(16, 9),
      iv: Buffer.alloc(12, 8),
      snKey: Buffer.alloc(16, 7),
    };
    const payload = Buffer.from("epoch-trial");
    const wire = encryptRecord(payload, ContentType.handshake, writeEp);

    // Act: resolver returns newest-first [7, 3]; 7 fails AEAD, 3 succeeds
    const dec = decryptRecord(wire, () => [wrongNewer, correct]);

    // Assert
    expect(dec).not.toBeNull();
    expect(dec!.epoch).toBe(3);
    expect(dec!.content.equals(payload)).toBe(true);
  });

  test("reconstructSequence advances window", () => {
    // Arrange / Act / Assert
    expect(reconstructSequence(5, 2, 0)).toBe(5);
    expect(reconstructSequence(1, 2, 0xfffe)).toBe(0x10001);
  });

  test("parseNextRecord throws DtlsDecodeError on truncated plaintext", () => {
    // Arrange: content-type handshake but only 5 bytes
    const partial = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x00]);
    // Act / Assert
    expect(() => parseNextRecord(partial, () => undefined)).toThrow(
      DtlsDecodeError,
    );
  });

  test("decryptRecord throws DtlsDecodeError on truncated ciphertext", () => {
    // Arrange: unified header claiming length beyond buffer
    const buf = Buffer.from([0x26, 0x00, 0x00, 0xff]); // incomplete
    // Act / Assert
    expect(() => decryptRecord(buf, () => undefined)).toThrow(DtlsDecodeError);
  });
});
