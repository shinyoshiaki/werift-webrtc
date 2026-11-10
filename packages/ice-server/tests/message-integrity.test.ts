import { describe, expect, it } from "vitest";

import { classes, methods } from "../src/stun/const";
import { Message, parseMessage } from "../src/stun/message";

/**
 * RFC 5389 / RFC 7675: when an integrity key is supplied, MESSAGE-INTEGRITY
 * must be present and valid. Unsigned success-class responses must be rejected.
 */
describe("parseMessage MESSAGE-INTEGRITY requirements", () => {
  const key = Buffer.from("remote-password", "utf8");

  function bindingResponse(signed: boolean) {
    const response = new Message(methods.BINDING, classes.RESPONSE);
    response.setAttribute("XOR-MAPPED-ADDRESS", ["192.0.2.50", 5000]);
    if (signed) {
      response.addMessageIntegrity(key).addFingerprint();
    }
    return response;
  }

  it("integrityKey 指定時、未署名 response は undefined（受理しない）", () => {
    // Arrange
    const unsigned = bindingResponse(false);
    expect(unsigned.attributesKeys).not.toContain("MESSAGE-INTEGRITY");

    // Act
    const parsed = parseMessage(unsigned.bytes, key);

    // Assert
    expect(parsed).toBeUndefined();
  });

  it("integrityKey 指定時、正しい MESSAGE-INTEGRITY は受理する", () => {
    // Arrange
    const signed = bindingResponse(true);

    // Act
    const parsed = parseMessage(signed.bytes, key);

    // Assert
    expect(parsed).toBeDefined();
    expect(parsed!.messageClass).toBe(classes.RESPONSE);
    expect(parsed!.attributesKeys).toContain("MESSAGE-INTEGRITY");
  });

  it("integrityKey 指定時、誤った鍵の MESSAGE-INTEGRITY は undefined", () => {
    // Arrange
    const signedWithOther = new Message(methods.BINDING, classes.RESPONSE);
    signedWithOther.setAttribute("XOR-MAPPED-ADDRESS", ["192.0.2.50", 5000]);
    signedWithOther
      .addMessageIntegrity(Buffer.from("wrong-password", "utf8"))
      .addFingerprint();

    // Act
    const parsed = parseMessage(signedWithOther.bytes, key);

    // Assert
    expect(parsed).toBeUndefined();
  });

  it("integrityKey 無しなら未署名 response もパースできる（後方互換）", () => {
    // Arrange
    const unsigned = bindingResponse(false);

    // Act
    const parsed = parseMessage(unsigned.bytes);

    // Assert
    expect(parsed).toBeDefined();
    expect(parsed!.messageClass).toBe(classes.RESPONSE);
  });
});

describe("Message.removeAttribute", () => {
  const key = Buffer.from("long-term-key", "utf8");

  it("署名を除いてから再署名すると、新しい内容で MESSAGE-INTEGRITY が検証できる", () => {
    // Arrange: 古い NONCE で署名済みの request
    const request = new Message(methods.REFRESH, classes.REQUEST)
      .setAttribute("LIFETIME", 600)
      .setAttribute("NONCE", Buffer.from("old-nonce"))
      .addMessageIntegrity(key)
      .addFingerprint();

    // Act: 署名を取り除き、NONCE を変えて再署名する
    request
      .removeAttribute("MESSAGE-INTEGRITY")
      .removeAttribute("FINGERPRINT")
      .setAttribute("NONCE", Buffer.from("new-nonce"))
      .addMessageIntegrity(key)
      .addFingerprint();

    // Assert: 署名は 1 つずつ末尾にあり、正しい鍵で検証できる
    expect(request.attributesKeys).toEqual([
      "LIFETIME",
      "NONCE",
      "MESSAGE-INTEGRITY",
      "FINGERPRINT",
    ]);
    expect(
      parseMessage(request.bytes, key)?.getAttributeValue("NONCE"),
    ).toEqual(Buffer.from("new-nonce"));
  });

  it("存在しない属性の削除は何も変えない", () => {
    // Arrange
    const request = new Message(methods.REFRESH, classes.REQUEST).setAttribute(
      "LIFETIME",
      600,
    );
    const before = request.bytes;

    // Act: 無い属性を削除する
    request.removeAttribute("MESSAGE-INTEGRITY");

    // Assert: wire bytes は変わらない
    expect(request.bytes).toEqual(before);
  });
});
