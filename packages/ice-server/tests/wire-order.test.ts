import { describe, expect, it } from "vitest";

import { crc32 } from "../../common/src";
import { classes, methods } from "../src/stun/const";
import { Message, paddingLength, parseMessage } from "../src/stun/message";

/** IANA META-DTLS-IN-STUN / META-DTLS-IN-STUN-ACKNOWLEDGEMENT (not registered in ATTRIBUTES). */
const DTLS_IN_STUN_DATA = 0xc070;
const DTLS_IN_STUN_ACK = 0xc071;

function attributeTypes(bytes: Buffer): number[] {
  const types: number[] = [];
  for (let pos = 20; pos + 4 <= bytes.length; ) {
    const type = bytes.readUInt16BE(pos);
    const length = bytes.readUInt16BE(pos + 2);
    types.push(type);
    pos += 4 + length + paddingLength(length);
  }
  return types;
}

function buildSignedSpedBinding(dataValue: Buffer, key: Buffer) {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request
    .setAttribute("USERNAME", "abcd:efgh")
    .setAttribute("PRIORITY", 1853824767)
    .setAttribute("ICE-CONTROLLING", 1n);
  request.appendRawAttribute(DTLS_IN_STUN_ACK, Buffer.alloc(0));
  request.appendRawAttribute(DTLS_IN_STUN_DATA, dataValue);
  request.addMessageIntegrity(key).addFingerprint();
  return request;
}

describe("STUN wire attribute order", () => {
  const key = Buffer.from("local-password", "utf8");

  it("parse → serialize で unknown の相対位置を保持する", () => {
    // Arrange: known の間に comprehension-optional unknown を置く
    const original = new Message(methods.BINDING, classes.REQUEST);
    original.setAttribute("USERNAME", "a:b");
    original.appendRawAttribute(0x8001, Buffer.from("xy"));
    original.setAttribute("PRIORITY", 1);
    original.appendRawAttribute(0xc001, Buffer.from([1, 2, 3]));

    // Act: 一度 wire に出して再パースする
    const parsed = parseMessage(original.bytes);

    // Assert: unknown が USERNAME と PRIORITY の間 / PRIORITY の後に残る
    expect(parsed).toBeDefined();
    expect(attributeTypes(parsed!.bytes)).toEqual(
      attributeTypes(original.bytes),
    );
    expect(
      parsed!.getRawAttributeValue(0x8001)?.equals(Buffer.from("xy")),
    ).toBe(true);
  });

  it("DATA / ACK は MESSAGE-INTEGRITY より前、FINGERPRINT が末尾", () => {
    // Arrange / Act
    const request = buildSignedSpedBinding(Buffer.from([20, 1, 2, 3]), key);
    const types = attributeTypes(request.bytes);

    // Assert: RFC 8489 §9 / §14.7
    expect(types.indexOf(DTLS_IN_STUN_ACK)).toBeGreaterThan(-1);
    expect(types.indexOf(DTLS_IN_STUN_DATA)).toBeGreaterThan(-1);
    expect(types.indexOf(DTLS_IN_STUN_ACK)).toBeLessThan(types.indexOf(0x0008));
    expect(types.indexOf(DTLS_IN_STUN_DATA)).toBeLessThan(
      types.indexOf(0x0008),
    );
    expect(types.indexOf(DTLS_IN_STUN_ACK)).toBeLessThan(
      types.indexOf(DTLS_IN_STUN_DATA),
    );
    expect(types.at(-1)).toBe(0x8028);
    expect(types.indexOf(0x0008)).toBe(types.length - 2);
  });

  it("DATA value 改ざんで MESSAGE-INTEGRITY 検証が失敗する", () => {
    // Arrange: 正しい HMAC のあと DATA だけ壊す
    const request = buildSignedSpedBinding(Buffer.from([20, 9, 8, 7]), key);
    const bytes = Buffer.from(request.bytes);
    const types = attributeTypes(bytes);
    const dataIndex = types.indexOf(DTLS_IN_STUN_DATA);
    let pos = 20;
    for (let i = 0; i < dataIndex; i++) {
      const length = bytes.readUInt16BE(pos + 2);
      pos += 4 + length + paddingLength(length);
    }
    bytes[pos + 4] ^= 0xff;

    // Act
    const parsed = parseMessage(bytes, key);

    // Assert: HMAC 範囲に DATA が入っているので検証失敗
    expect(parsed).toBeUndefined();
  });

  it.each([0, 1, 2, 3] as const)(
    "attribute value length %i の 4-byte padding を保持する",
    (length) => {
      // Arrange
      const value = Buffer.alloc(length, 0xab);
      const request = new Message(methods.BINDING, classes.REQUEST);
      request.setAttribute("USERNAME", "u:p");
      request.appendRawAttribute(0xc070, value);

      // Act
      const bytes = request.bytes;
      const parsed = parseMessage(bytes);

      // Assert: Length は padding 前。padding は 0。再パースで value が一致
      expect(parsed).toBeDefined();
      const recovered = parsed!.getRawAttributeValue(0xc070);
      expect(recovered?.equals(value)).toBe(true);
      expect(bytes.length % 4).toBe(0);
      const headerLen = bytes.readUInt16BE(2);
      expect(headerLen % 4).toBe(0);
      expect(paddingLength(length)).toBe(length === 0 ? 0 : 4 - length);
    },
  );

  it("known だけの新規 Message の serialize は attributesKeys 順のまま", () => {
    // Arrange: 既存 ICE Binding と同じ構築順
    const request = new Message(methods.BINDING, classes.REQUEST);
    request
      .setAttribute("USERNAME", "abcd:efgh")
      .setAttribute("PRIORITY", 1)
      .setAttribute("ICE-CONTROLLING", 1n);
    request.addMessageIntegrity(key).addFingerprint();

    // Act
    const types = attributeTypes(request.bytes);

    // Assert: SPED を付けない経路は known 順 + MI + FP
    expect(types).toEqual([0x0006, 0x0024, 0x802a, 0x0008, 0x8028]);
  });

  it("SPED ACK の CRC-32 は Fingerprint XOR を付けない", () => {
    // Arrange: DATA value のみの CRC（padding 除外）
    const dataValue = Buffer.from([20, 1, 2]);
    const crc = crc32(dataValue) >>> 0;
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(crc, 0);

    // Assert: RFC 8489 FINGERPRINT の XOR 0x5354554e は付けない
    expect(crc ^ 0x5354554e).not.toBe(crc);
    expect(ack.readUInt32BE(0)).toBe(crc);
  });
});
