import { describe, expect, it } from "vitest";

import { classes, methods } from "../src/stun/const";
import { Message, parseMessage } from "../src/stun/message";
import {
  appendAttribute,
  appendFingerprint,
  appendIntegritySha256,
  attributeBytes,
  bindingResponse,
  corruptAttribute,
  FINGERPRINT,
  integrityHmac,
  integrityKey as key,
  MESSAGE_INTEGRITY,
  MESSAGE_INTEGRITY_SHA256,
  SOFTWARE,
  signedBindingResponse,
  wireAttributeTypes,
  wrongIntegrityKey,
} from "./messageIntegrityUtils";

const XOR_MAPPED_ADDRESS = 0x0020;

/**
 * RFC 5389 / RFC 7675: when an integrity key is supplied, MESSAGE-INTEGRITY
 * must be present and valid. Unsigned success-class responses must be rejected.
 */
describe("parseMessage MESSAGE-INTEGRITY requirements", () => {
  it("integrityKey 指定時、未署名 response は undefined（受理しない）", () => {
    // Arrange
    const unsigned = bindingResponse();
    expect(unsigned.attributesKeys).not.toContain("MESSAGE-INTEGRITY");

    // Act: 鍵を指定して未署名メッセージをパースする
    const parsed = parseMessage(unsigned.bytes, key);

    // Assert: 認証を要求したので受理されない
    expect(parsed).toBeUndefined();
  });

  it("integrityKey 指定時、正しい MESSAGE-INTEGRITY は受理する", () => {
    // Arrange
    const signed = signedBindingResponse((m) =>
      m.addMessageIntegrity(key).addFingerprint(),
    );

    // Act: 正しい鍵でパースする
    const parsed = parseMessage(signed, key);

    // Assert: 受理され、SHA-1 で署名されたと判別できる
    expect(parsed).toBeDefined();
    expect(parsed!.messageClass).toBe(classes.RESPONSE);
    expect(parsed!.attributesKeys).toContain("MESSAGE-INTEGRITY");
    expect(parsed!.integrityAlgorithm).toBe("sha1");
  });

  it("integrityKey 指定時、誤った鍵の MESSAGE-INTEGRITY は undefined", () => {
    // Arrange
    const signedWithOther = signedBindingResponse((m) =>
      m.addMessageIntegrity(wrongIntegrityKey).addFingerprint(),
    );

    // Act: 署名と異なる鍵でパースする
    const parsed = parseMessage(signedWithOther, key);

    // Assert: HMAC 不一致で受理されない
    expect(parsed).toBeUndefined();
  });

  it("integrityKey 無しなら未署名 response もパースできる（後方互換）", () => {
    // Arrange
    const unsigned = bindingResponse();

    // Act: 鍵なしでパースする
    const parsed = parseMessage(unsigned.bytes);

    // Assert: 認証を要求していないので受理される
    expect(parsed).toBeDefined();
    expect(parsed!.messageClass).toBe(classes.RESPONSE);
    expect(parsed!.integrityAlgorithm).toBeUndefined();
  });
});

/** RFC 8489 §14.6 / §9.1.4: MESSAGE-INTEGRITY-SHA256 with short-term credentials. */
describe("MESSAGE-INTEGRITY-SHA256", () => {
  it("MI-SHA256 だけの署名は正しい鍵で受理し、誤った鍵では undefined", () => {
    // Arrange
    const signed = signedBindingResponse((m) =>
      m.addMessageIntegritySha256(key).addFingerprint(),
    );

    // Act: 正しい鍵と誤った鍵でそれぞれパースする
    const accepted = parseMessage(signed, key);
    const rejected = parseMessage(signed, wrongIntegrityKey);

    // Assert: 正しい鍵だけ受理され、SHA-256 で署名されたと判別できる
    expect(accepted).toBeDefined();
    expect(accepted!.integrityAlgorithm).toBe("sha256");
    expect(accepted!.attributesKeys).not.toContain("MESSAGE-INTEGRITY");
    expect(rejected).toBeUndefined();
  });

  it("生成した MI-SHA256 は独立に計算した HMAC-SHA256 と一致する", () => {
    // Arrange
    const message = bindingResponse();
    const unsigned = message.bytes;

    // Act: Message で MI-SHA256 を付与する
    const signed = message.addMessageIntegritySha256(key);

    // Assert: ヘッダ長を MI-SHA256 末尾まで含めて計算した HMAC と一致する
    expect(signed.getAttributeValue("MESSAGE-INTEGRITY-SHA256")).toEqual(
      integrityHmac(unsigned, "sha256", key, 32),
    );
  });

  it("MI と MI-SHA256 の併用時は MI-SHA256 だけで検証する", () => {
    // Arrange: MI-SHA256 は先行する MI も HMAC 範囲に含むため、「壊れた」側は
    // 誤った鍵で署名して作る
    const both = signedBindingResponse((m) =>
      m.addIntegrity(key, "both").addFingerprint(),
    );
    const wrongSha1 = signedBindingResponse((m) =>
      m
        .addMessageIntegrity(wrongIntegrityKey)
        .addMessageIntegritySha256(key)
        .addFingerprint(),
    );
    const wrongSha256 = signedBindingResponse((m) =>
      m
        .addMessageIntegrity(key)
        .addMessageIntegritySha256(wrongIntegrityKey)
        .addFingerprint(),
    );

    // Act: 両方正しいもの、MI だけ不正なもの、MI-SHA256 だけ不正なものをパースする
    const parsedBoth = parseMessage(both, key);
    const parsedWrongSha1 = parseMessage(wrongSha1, key);
    const parsedWrongSha256 = parseMessage(wrongSha256, key);

    // Assert: MI-SHA256 が正しければ MI が不正でも受理し、逆は拒否する
    expect(parsedBoth?.integrityAlgorithm).toBe("sha256");
    expect(parsedWrongSha1?.integrityAlgorithm).toBe("sha256");
    expect(parsedWrongSha256).toBeUndefined();
  });

  it.each([16, 20, 24, 28, 32])(
    "切り詰め長 %i バイトの MI-SHA256 を生成・受理する",
    (length) => {
      // Arrange
      const signed = signedBindingResponse((m) =>
        m.addMessageIntegritySha256(key, length).addFingerprint(),
      );

      // Act: 正しい鍵でパースする
      const parsed = parseMessage(signed, key);

      // Assert: 受理され、受信した長さのまま保持される
      expect(parsed).toBeDefined();
      expect(
        (parsed!.getAttributeValue("MESSAGE-INTEGRITY-SHA256") as Buffer)
          .length,
      ).toBe(length);
    },
  );

  it.each([12, 18, 33])(
    "不正な長さ %i バイトの MI-SHA256 は鍵指定時に undefined",
    (length) => {
      // Arrange: HMAC 自体は正しく計算し、長さだけを不正にする
      const signed = appendIntegritySha256(
        bindingResponse().bytes,
        key,
        length,
      );

      // Act: 正しい鍵でパースする
      const parsed = parseMessage(signed, key);

      // Assert: 長さ不正として受理されない
      expect(parsed).toBeUndefined();
    },
  );

  it.each([0, 12, 18, 33, 36])(
    "addMessageIntegritySha256 は不正な切り詰め長 %i を例外にする",
    (length) => {
      // Arrange
      const message = bindingResponse();

      // Act / Assert: RFC 8489 §14.6 の範囲外なので RangeError
      expect(() => message.addMessageIntegritySha256(key, length)).toThrow(
        RangeError,
      );
    },
  );

  it("MI → MI-SHA256 → FINGERPRINT の順で並び、FINGERPRINT の CRC が正しい", () => {
    // Arrange
    const message = bindingResponse();

    // Act: 両方の完全性属性と FINGERPRINT を付与する
    const signed = message.addIntegrity(key, "both").addFingerprint().bytes;

    // Assert: ワイヤ上の順序が RFC 8489 どおりで、鍵なし（FINGERPRINT のみ検証）
    // でも鍵ありでも受理される
    expect(wireAttributeTypes(signed)).toEqual([
      XOR_MAPPED_ADDRESS,
      MESSAGE_INTEGRITY,
      MESSAGE_INTEGRITY_SHA256,
      FINGERPRINT,
    ]);
    expect(parseMessage(signed)).toBeDefined();
    expect(parseMessage(signed, key)).toBeDefined();
    expect(parseMessage(corruptAttribute(signed, FINGERPRINT))).toBeUndefined();
  });

  it("MI-SHA256 の後に MI、FINGERPRINT の後に MI-SHA256 は付与できない", () => {
    // Arrange
    const sha256First = bindingResponse().addMessageIntegritySha256(key);
    const fingerprinted = bindingResponse().addFingerprint();

    // Act / Assert: RFC 8489 の順序に反する付与は例外にする
    expect(() => sha256First.addMessageIntegrity(key)).toThrow();
    expect(() => fingerprinted.addMessageIntegritySha256(key)).toThrow();
  });

  it("addIntegrity は mode に応じた完全性属性を付与する", () => {
    // Act: 各 mode で署名する
    const sha1 = bindingResponse().addIntegrity(key);
    const sha256 = bindingResponse().addIntegrity(key, "sha256");
    const both = bindingResponse().addIntegrity(key, "both");

    // Assert: 既定は SHA-1 のみ、sha256 は SHA-256 のみ、both は両方
    expect(sha1.attributesKeys).toEqual([
      "XOR-MAPPED-ADDRESS",
      "MESSAGE-INTEGRITY",
    ]);
    expect(sha256.attributesKeys).toEqual([
      "XOR-MAPPED-ADDRESS",
      "MESSAGE-INTEGRITY-SHA256",
    ]);
    expect(both.attributesKeys).toEqual([
      "XOR-MAPPED-ADDRESS",
      "MESSAGE-INTEGRITY",
      "MESSAGE-INTEGRITY-SHA256",
    ]);
  });
});

/**
 * RFC 8489 §14.5 / §14.6: attributes after MESSAGE-INTEGRITY other than
 * MESSAGE-INTEGRITY-SHA256 / FINGERPRINT, and after MESSAGE-INTEGRITY-SHA256
 * other than FINGERPRINT, are ignored.
 */
describe("attributes after the integrity attributes", () => {
  it("MI の後ろの既知・未知属性は保持せず、署名検証も通る", () => {
    // Arrange: MI の後ろに SOFTWARE と未知の comprehension-optional 属性を足す
    const signed = signedBindingResponse((m) => m.addMessageIntegrity(key));
    const trailing = appendAttribute(
      appendAttribute(signed, attributeBytes(SOFTWARE, Buffer.from("x"))),
      attributeBytes(0xc0fe, Buffer.from("unknown")),
    );

    // Act: 鍵ありと鍵なしでパースする
    const verified = parseMessage(trailing, key);
    const unverified = parseMessage(trailing);

    // Assert: どちらも後続属性を無視する
    for (const parsed of [verified, unverified]) {
      expect(parsed).toBeDefined();
      expect(parsed!.attributesKeys).toEqual([
        "XOR-MAPPED-ADDRESS",
        "MESSAGE-INTEGRITY",
      ]);
      expect(parsed!.rawAttributes).toEqual([]);
    }
  });

  it("MI-SHA256 の後ろの MI は無視し、MI-SHA256 で検証する", () => {
    // Arrange: MI-SHA256 の後ろに（誤った鍵の）MI を足す
    const signed = signedBindingResponse((m) =>
      m.addMessageIntegritySha256(key),
    );
    const trailingSha1 = appendAttribute(
      signed,
      attributeBytes(
        MESSAGE_INTEGRITY,
        integrityHmac(signed, "sha1", wrongIntegrityKey, 20),
      ),
    );

    // Act: 正しい鍵でパースする
    const parsed = parseMessage(trailingSha1, key);

    // Assert: 後ろの MI は無視され、MI-SHA256 だけで受理される
    expect(parsed).toBeDefined();
    expect(parsed!.attributesKeys).toEqual([
      "XOR-MAPPED-ADDRESS",
      "MESSAGE-INTEGRITY-SHA256",
    ]);
  });

  it("MI と FINGERPRINT の間の無視される属性も FINGERPRINT の CRC 範囲に含まれる", () => {
    // Arrange: MI → SOFTWARE → FINGERPRINT（CRC は SOFTWARE を含めて計算）
    const signed = signedBindingResponse((m) => m.addMessageIntegrity(key));
    const withSoftware = appendAttribute(
      signed,
      attributeBytes(SOFTWARE, Buffer.from("between")),
    );
    const withFingerprint = appendFingerprint(withSoftware);

    // Act: 鍵ありでパースする
    const parsed = parseMessage(withFingerprint, key);

    // Assert: SOFTWARE は無視され、FINGERPRINT は検証・保持される
    expect(parsed).toBeDefined();
    expect(parsed!.attributesKeys).toEqual([
      "XOR-MAPPED-ADDRESS",
      "MESSAGE-INTEGRITY",
      "FINGERPRINT",
    ]);
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
