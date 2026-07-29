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
