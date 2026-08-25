import { describe, expect, it } from "vitest";

import { crc32 } from "../../common/src";
import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  HEADER_LENGTH,
  classes,
  methods,
} from "../src/stun/const";
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

function rewriteStunMessageLength(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  out.writeUInt16BE(out.length - HEADER_LENGTH, 2);
  return out;
}

function serializeRawAttribute(type: number, value: Buffer): Buffer {
  const padLen = paddingLength(value.length);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value, Buffer.alloc(padLen)]);
}

function appendFingerprint(prefix: Buffer): Buffer {
  const checkData = Buffer.from(prefix);
  checkData.writeUInt16BE(
    prefix.length - HEADER_LENGTH + FINGERPRINT_LENGTH,
    2,
  );
  const fingerprint = (crc32(checkData) ^ FINGERPRINT_XOR) >>> 0;
  const value = Buffer.alloc(4);
  value.writeUInt32BE(fingerprint, 0);
  return rewriteStunMessageLength(
    Buffer.concat([prefix, serializeRawAttribute(0x8028, value)]),
  );
}

function buildSignedBindingWithoutSped(key: Buffer, fingerprint: boolean) {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request
    .setAttribute("USERNAME", "abcd:efgh")
    .setAttribute("PRIORITY", 1853824767)
    .setAttribute("ICE-CONTROLLING", 1n)
    .addMessageIntegrity(key);
  if (fingerprint) {
    request.addFingerprint();
  }
  return request;
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

    const parsed = parseMessage(request.bytes, key);
    expect(parsed).toBeDefined();
    expect(
      parsed!
        .getRawAttributeValue(DTLS_IN_STUN_DATA)
        ?.equals(Buffer.from([20, 1, 2, 3])),
    ).toBe(true);
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

  it("認証付き parse は MESSAGE-INTEGRITY 後の DATA/ACK を公開しない", () => {
    // Arrange: HMAC 対象外へ DATA/ACK を挿し、FINGERPRINT だけ付け直す
    const request = buildSignedBindingWithoutSped(key, false);
    const data = Buffer.from([22, 9, 8, 7]);
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(0xdeadbeef, 0);
    const tampered = appendFingerprint(
      Buffer.concat([
        request.bytes,
        serializeRawAttribute(DTLS_IN_STUN_ACK, ack),
        serializeRawAttribute(DTLS_IN_STUN_DATA, data),
      ]),
    );

    // Act
    const parsed = parseMessage(tampered, key);

    // Assert: HMAC は通るが DATA/ACK は認証済み属性に出ない
    expect(parsed).toBeDefined();
    expect(parsed!.getRawAttributeValue(DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(parsed!.getRawAttributeValue(DTLS_IN_STUN_ACK)).toBeUndefined();
  });

  it("認証付き parse は FINGERPRINT 後の DATA/ACK を公開しない", () => {
    // Arrange: 長さフィールドを更新して FP の後ろへ DATA/ACK を足す
    const request = buildSignedBindingWithoutSped(key, true);
    const data = Buffer.from([22, 9, 8, 7]);
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(0xdeadbeef, 0);
    const tampered = rewriteStunMessageLength(
      Buffer.concat([
        request.bytes,
        serializeRawAttribute(DTLS_IN_STUN_ACK, ack),
        serializeRawAttribute(DTLS_IN_STUN_DATA, data),
      ]),
    );

    // Act
    const parsed = parseMessage(tampered, key);

    // Assert: HMAC / FP は通るが DATA/ACK は認証済み属性に出ない
    expect(parsed).toBeDefined();
    expect(parsed!.getRawAttributeValue(DTLS_IN_STUN_DATA)).toBeUndefined();
    expect(parsed!.getRawAttributeValue(DTLS_IN_STUN_ACK)).toBeUndefined();
  });

  it("認証付き parse は MESSAGE-INTEGRITY 後の通常 MI を無視する", () => {
    // Arrange: 検証済み MI の後ろに HMAC が合わない MI を置く
    const request = buildSignedBindingWithoutSped(key, false);
    const firstIntegrity = request.getAttributeValue("MESSAGE-INTEGRITY");
    const tampered = appendFingerprint(
      Buffer.concat([
        request.bytes,
        serializeRawAttribute(0x0008, Buffer.alloc(20, 0xff)),
      ]),
    );

    // Act
    const parsed = parseMessage(tampered, key);

    // Assert: 2 つ目の MI を再検証せず、最初の HMAC だけを残す
    expect(parsed).toBeDefined();
    expect(parsed!.getAttributeValue("MESSAGE-INTEGRITY")).toEqual(
      firstIntegrity,
    );
  });

  it("認証付き parse は MESSAGE-INTEGRITY 後の malformed known で失敗しない", () => {
    // Arrange: unpack が throw する XOR-MAPPED-ADDRESS を MI 後へ置く
    const request = buildSignedBindingWithoutSped(key, false);
    const tampered = appendFingerprint(
      Buffer.concat([
        request.bytes,
        serializeRawAttribute(0x0020, Buffer.from([0x01])),
      ]),
    );

    // Act
    const parsed = parseMessage(tampered, key);

    // Assert: 認証済みメッセージ全体を落とさず、malformed 属性は公開しない
    expect(parsed).toBeDefined();
    expect(parsed!.attributesKeys).not.toContain("XOR-MAPPED-ADDRESS");
  });
});
