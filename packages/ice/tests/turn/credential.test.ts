import { describe, expect, test } from "vitest";
import type { AttributeKey } from "../../src/stun/attributes";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import {
  credentialRetryOf,
  parseNonceSecurityFeatures,
} from "../../src/turn/credential";
import { TURN_TEST_REALM, turnTestIntegrityKey } from "../utils";

function errorResponse(
  errorCode: number,
  attributes: [AttributeKey, unknown][] = [],
) {
  const response = new Message(
    methods.CHANNEL_BIND,
    classes.ERROR,
  ).setAttribute("ERROR-CODE", [errorCode, "error"]);
  for (const [key, value] of attributes) response.setAttribute(key, value);
  return response;
}

const nonce = Buffer.from("nonce-2");
const unauthenticated = { authenticated: false };
const authenticated = { authenticated: true, realm: TURN_TEST_REALM };

describe("parseNonceSecurityFeatures", () => {
  test.each([
    {
      nonce: "plain-nonce",
      expected: undefined,
    },
    {
      nonce: "obMatJos2AAAAxyz",
      expected: { passwordAlgorithms: false, usernameAnonymity: false },
    },
    // RFC 8489 §18.1 (erratum 6290): bit 0 is the least significant bit.
    {
      nonce: "obMatJos2AAABxyz",
      expected: { passwordAlgorithms: true, usernameAnonymity: false },
    },
    {
      nonce: "obMatJos2AAACf//499k954d6OL34oL9FSTvy64sA",
      expected: { passwordAlgorithms: false, usernameAnonymity: true },
    },
    // RFC 8489 §9.2: bit 0 is the most significant bit.
    {
      nonce: "obMatJos2gAAAxyz",
      expected: { passwordAlgorithms: true, usernameAnonymity: false },
    },
    {
      nonce: "obMatJos2QAAAxyz",
      expected: { passwordAlgorithms: false, usernameAnonymity: true },
    },
    {
      nonce: "obMatJos2AA",
      expected: { passwordAlgorithms: true, usernameAnonymity: true },
    },
    {
      nonce: "obMatJos2A*AAxyz",
      expected: { passwordAlgorithms: true, usernameAnonymity: true },
    },
  ])("$nonce", ({ nonce, expected }) => {
    // Act: NONCE の nonce cookie を解析する
    const features = parseNonceSecurityFeatures(Buffer.from(nonce));

    // Assert: cookie の無い NONCE は undefined、不正な feature set は全機能ありとみなす
    expect(features).toEqual(expected);
  });
});

describe("credentialRetryOf", () => {
  test("未認証 request への 401 は応答の REALM と NONCE でリトライする", () => {
    // Act: 初回 Allocate への 401 を判定する
    const retry = credentialRetryOf(
      errorResponse(401, [
        ["REALM", TURN_TEST_REALM],
        ["NONCE", nonce],
      ]),
      unauthenticated,
      undefined,
    );

    // Assert: 応答の REALM/NONCE を使う
    expect(retry).toEqual({ realm: TURN_TEST_REALM, nonce });
  });

  test("認証済み request への同じ REALM の 401 はリトライしない", () => {
    // Act: 同じ認証情報で再送することになる 401 を判定する
    const retry = credentialRetryOf(
      errorResponse(401, [
        ["REALM", TURN_TEST_REALM],
        ["NONCE", nonce],
      ]),
      authenticated,
      TURN_TEST_REALM,
    );

    // Assert: RFC 8489 §9.2.5 によりリトライしない
    expect(retry).toBeUndefined();
  });

  test("認証済み request への別 REALM の 401 は新しい REALM でリトライする", () => {
    // Act: REALM が変わった 401 を判定する
    const retry = credentialRetryOf(
      errorResponse(401, [
        ["REALM", "new.realm"],
        ["NONCE", nonce],
      ]),
      authenticated,
      TURN_TEST_REALM,
    );

    // Assert: 新しい REALM でリトライする
    expect(retry).toEqual({ realm: "new.realm", nonce });
  });

  test.each([
    { name: "REALM なし", attributes: [["NONCE", nonce]] },
    {
      name: "同じ REALM",
      attributes: [
        ["REALM", TURN_TEST_REALM],
        ["NONCE", nonce],
      ],
    },
  ] as { name: string; attributes: [AttributeKey, unknown][] }[])(
    "438 ($name) は現在の REALM と新しい NONCE でリトライする",
    ({ attributes }) => {
      // Act: Stale Nonce を判定する
      const retry = credentialRetryOf(
        errorResponse(438, attributes),
        authenticated,
        TURN_TEST_REALM,
      );

      // Assert: REALM は現在の値のまま NONCE だけ更新する
      expect(retry).toEqual({ realm: TURN_TEST_REALM, nonce });
    },
  );

  test.each([
    {
      name: "401/438 以外",
      code: 403,
      attributes: [
        ["REALM", "new.realm"],
        ["NONCE", nonce],
      ],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "NONCE なしの 401",
      code: 401,
      attributes: [["REALM", "new.realm"]],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "REALM なしの 401",
      code: 401,
      attributes: [["NONCE", nonce]],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "現在の REALM が無い 438",
      code: 438,
      attributes: [["NONCE", nonce]],
      currentRealm: undefined,
    },
    {
      name: "別 REALM の 438",
      code: 438,
      attributes: [
        ["REALM", "new.realm"],
        ["NONCE", nonce],
      ],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "Password algorithms bit 付き nonce cookie",
      code: 438,
      attributes: [["NONCE", Buffer.from("obMatJos2AAABxyz")]],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "Username anonymity bit 付き nonce cookie",
      code: 438,
      attributes: [["NONCE", Buffer.from("obMatJos2AAACxyz")]],
      currentRealm: TURN_TEST_REALM,
    },
    {
      name: "PASSWORD-ALGORITHMS 付き nonce cookie",
      code: 401,
      attributes: [
        ["REALM", "new.realm"],
        ["NONCE", Buffer.from("obMatJos2AAAAxyz")],
        ["PASSWORD-ALGORITHMS", Buffer.from([0, 2, 0, 0])],
      ],
      currentRealm: TURN_TEST_REALM,
    },
  ] as {
    name: string;
    code: number;
    attributes: [AttributeKey, unknown][];
    currentRealm: string | undefined;
  }[])("$name はリトライしない", ({ code, attributes, currentRealm }) => {
    // Act: リトライ条件を満たさないエラーを判定する
    const retry = credentialRetryOf(
      errorResponse(code, attributes),
      authenticated,
      currentRealm,
    );

    // Assert: エラーは最終結果として扱う
    expect(retry).toBeUndefined();
  });
});

describe("re-signing a signed request", () => {
  test("既存の MESSAGE-INTEGRITY/FINGERPRINT を除いて再署名すると検証を通る", () => {
    // Arrange: 古い NONCE で署名済みの request
    const key = turnTestIntegrityKey();
    const request = new Message(methods.CHANNEL_BIND, classes.REQUEST)
      .setAttribute("CHANNEL-NUMBER", 0x4000)
      .setAttribute("NONCE", Buffer.from("nonce-1"))
      .addMessageIntegrity(key)
      .addFingerprint();

    // Act: transactionId と NONCE を変え、古い署名を除いて再署名する
    request.transactionId = Buffer.alloc(12, 1);
    request
      .removeAttribute("MESSAGE-INTEGRITY")
      .removeAttribute("FINGERPRINT")
      .setAttribute("NONCE", nonce)
      .addMessageIntegrity(key)
      .addFingerprint();

    // Assert: 正しい鍵で MESSAGE-INTEGRITY と FINGERPRINT が検証でき、署名は末尾にある
    const parsed = parseMessage(request.bytes, key);
    expect(parsed?.getAttributeValue("NONCE")).toEqual(nonce);
    expect(request.attributesKeys).toEqual([
      "CHANNEL-NUMBER",
      "NONCE",
      "MESSAGE-INTEGRITY",
      "FINGERPRINT",
    ]);
  });

  test("古い署名を残したまま再署名すると検証に失敗する", () => {
    // Arrange: 古い NONCE で署名済みの request
    const key = turnTestIntegrityKey();
    const request = new Message(methods.CHANNEL_BIND, classes.REQUEST)
      .setAttribute("NONCE", Buffer.from("nonce-1"))
      .addMessageIntegrity(key)
      .addFingerprint();

    // Act: 古い署名の上から再署名する(修正前の挙動)
    request.transactionId = Buffer.alloc(12, 1);
    request
      .setAttribute("NONCE", nonce)
      .addMessageIntegrity(key)
      .addFingerprint();

    // Assert: MESSAGE-INTEGRITY が不正になる
    expect(parseMessage(request.bytes, key)).toBeUndefined();
  });
});
