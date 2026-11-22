// WebIDL 変換規則の「入力 × 入口」マトリクス。
// 入口: RTCDataChannel.binaryType の setter (enum 属性) と
//       RTCSessionDescription の辞書形式コンストラクタ (DOMString sdp = "" / 必須 enum type)。
// 期待値は WebIDL (https://webidl.spec.whatwg.org/#es-DOMString, #es-enumeration,
// #es-dictionary) から導き、無効な enum 値を無視する setter は固定版 WPT
// third_party/wpt/webrtc/RTCDataChannel-binaryType.window.js (121babb3) と一致させる。
import { afterEach, describe, expect, test } from "vitest";

import { RTCPeerConnection, RTCSessionDescription } from "../src";

const SDP = "v=0\r\n";
const thrown = new Error("toString failed");

/** 入力ごとの WebIDL 上の期待値。"TypeError" / thrown は例外、それ以外は変換結果。 */
const inputs: {
  name: string;
  /** valid: その入口で有効な文字列 (setter "blob" / sdp SDP / type "offer") */
  value: (valid: string) => unknown;
  /** binaryType setter: 反映される値、または undefined (無視) / 例外 */
  setter: "blob" | undefined | "TypeError" | typeof thrown;
  /** 辞書の sdp メンバー */
  sdp: string | "TypeError" | typeof thrown;
  /** 辞書の type メンバー */
  type: "offer" | "TypeError" | typeof thrown;
}[] = [
  {
    name: "undefined",
    value: () => undefined,
    setter: undefined,
    sdp: "",
    type: "TypeError",
  },
  {
    name: "null",
    value: () => null,
    setter: undefined,
    sdp: "null",
    type: "TypeError",
  },
  {
    name: "a number",
    value: () => 234,
    setter: undefined,
    sdp: "234",
    type: "TypeError",
  },
  {
    name: "a bigint",
    value: () => BigInt(54),
    setter: undefined,
    sdp: "54",
    type: "TypeError",
  },
  {
    name: "a Symbol",
    value: () => Symbol("x"),
    setter: "TypeError",
    sdp: "TypeError",
    type: "TypeError",
  },
  {
    name: "an object whose toString() gives a valid value",
    value: (valid) => ({ toString: () => valid }),
    setter: "blob",
    sdp: SDP,
    type: "offer",
  },
  {
    name: "an object whose toString() throws",
    value: () => ({
      toString() {
        throw thrown;
      },
    }),
    setter: thrown,
    sdp: thrown,
    type: thrown,
  },
];

function expectThrowOf(
  act: () => unknown,
  expected: "TypeError" | typeof thrown,
) {
  if (expected === "TypeError") {
    expect(act).toThrow(TypeError);
  } else {
    expect(act).toThrow(expected);
  }
}

describe("WebIDL conversion: RTCDataChannel.binaryType setter", () => {
  const pcs: RTCPeerConnection[] = [];
  afterEach(async () => {
    await Promise.all(pcs.splice(0).map((pc) => pc.close()));
  });

  test.each(inputs)("$name", (input) => {
    // Arrange: 交渉していない channel を arraybuffer にしておく
    const pc = new RTCPeerConnection();
    pcs.push(pc);
    const channel = pc.createDataChannel("webidl");
    channel.binaryType = "arraybuffer";
    const value = input.value("blob");

    // Act: ToString してから enum と照合する setter に代入する
    const assign = () => {
      channel.binaryType = value as never;
    };

    if (input.setter === "TypeError" || input.setter === thrown) {
      // Assert: ToString の例外がそのまま出て、値は変わらない
      expectThrowOf(assign, input.setter);
      expect(channel.binaryType).toBe("arraybuffer");
    } else {
      assign();
      // Assert: 有効値なら反映、無効値は例外なしで無視して前の値を保つ
      expect(channel.binaryType).toBe(input.setter ?? "arraybuffer");
    }
  });
});

describe("WebIDL conversion: RTCSessionDescription({ sdp }) member", () => {
  test.each(inputs)("$name", (input) => {
    // Arrange: type は有効、sdp だけを入力にする
    const init = { type: "offer", sdp: input.value(SDP) };

    // Act: 辞書形式で作る
    const create = () => new RTCSessionDescription(init as never);

    if (input.sdp === "TypeError" || input.sdp === thrown) {
      // Assert: DOMString 変換の例外がそのまま出る
      expectThrowOf(create, input.sdp);
    } else {
      // Assert: undefined だけが既定値 ""、他は ToString の結果
      expect(create().sdp).toBe(input.sdp);
    }
  });
});

describe("WebIDL conversion: RTCSessionDescription({ type }) member", () => {
  test.each(inputs)("$name", (input) => {
    // Arrange: sdp は有効、type だけを入力にする
    const init = { type: input.value("offer"), sdp: SDP };

    // Act: 辞書形式で作る
    const create = () => new RTCSessionDescription(init as never);

    if (input.type === "TypeError" || input.type === thrown) {
      // Assert: 必須欠落・無効な enum 値・ToString の失敗はすべて例外
      expectThrowOf(create, input.type);
    } else {
      // Assert: ToString した結果が enum 値なら受け付ける
      expect(create().type).toBe(input.type);
    }
  });
});

describe("WebIDL conversion: RTCSessionDescription dictionary", () => {
  test("members are read once each, sdp before type", () => {
    // Arrange: getter の呼び出しを記録する辞書
    const reads: string[] = [];
    const init = {
      get type() {
        reads.push("type");
        return "answer";
      },
      get sdp() {
        reads.push("sdp");
        return SDP;
      },
    };

    // Act: 辞書形式で作る
    const description = new RTCSessionDescription(init as never);

    // Assert: 辞書順 (sdp → type) に 1 回ずつ読む
    expect(reads).toEqual(["sdp", "type"]);
    expect(description.toJSON()).toEqual({ sdp: SDP, type: "answer" });
  });

  test("a second argument after a dictionary is ignored", () => {
    // Act: 辞書と余分な第 2 引数を渡す
    const description = new (
      RTCSessionDescription as unknown as new (
        ...args: unknown[]
      ) => RTCSessionDescription
    )({ type: "offer", sdp: SDP }, "answer");

    // Assert: 旧 2 引数形式には入らず、辞書の値だけが使われる
    expect(description.type).toBe("offer");
    expect(description.sdp).toBe(SDP);
  });

  test.each([
    { name: "a number", init: 1 },
    { name: "a boolean", init: true },
    { name: "a Symbol", init: Symbol("x") },
  ])("$name is not a dictionary (TypeError)", ({ init }) => {
    // Act / Assert: object 以外 (undefined / null と旧形式の string を除く) は辞書に変換できない
    expect(() => new RTCSessionDescription(init as never)).toThrow(TypeError);
  });

  test.each([
    { name: "undefined", init: undefined },
    { name: "null", init: null },
  ])(
    "$name is an empty dictionary, so the required type is missing",
    ({ init }) => {
      // Act / Assert: 空辞書として扱い、必須の type が無いので TypeError
      expect(() => new RTCSessionDescription(init as never)).toThrow(
        /type is required/,
      );
    },
  );

  test("a string first argument keeps the legacy (sdp, type) form", () => {
    // Act: 旧 2 引数形式で作る
    const description = new RTCSessionDescription(SDP, "pranswer");

    // Assert: 従来どおり検証なしでそのまま使う
    expect(description.toJSON()).toEqual({ sdp: SDP, type: "pranswer" });
  });
});
