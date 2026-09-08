import { OverconstrainedError } from "../../src/errors";
import { shouldInstallMediaDevices } from "../../src/polyfill/existingMediaDevices";
import {
  assertRequestedMediaTypes,
  selectRegisterForKind,
} from "../../src/polyfill/selectSettings";
import { createPolyfillRegisterCandidates } from "./polyfillSelectSettingsTestUtils";

describe("polyfill SelectSettings / getUserMedia errors", () => {
  test("empty MediaStreamConstraints rejects with TypeError", () => {
    // 実行: audio/video のどちらも要求しない。
    let thrown: unknown;
    try {
      assertRequestedMediaTypes({});
    } catch (error) {
      thrown = error;
    }

    // 検証: WPT GUM-empty-option-param と同様に TypeError。
    expect(thrown).toBeInstanceOf(TypeError);
  });

  test("no register of the requested kind rejects with NotFoundError", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "mic", mimeType: "audio/opus", kinds: ["audio"] },
    ]);

    // 実行: video デバイスが無い状態で video を要求する。
    let thrown: unknown;
    try {
      selectRegisterForKind("video", true, candidates);
    } catch (error) {
      thrown = error;
    }

    // 検証: 仕様の NotFound Failure は NotFoundError。
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("NotFoundError");
  });

  test("required mimeType that no candidate satisfies rejects with OverconstrainedError", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "cam-a", mimeType: "video/VP8", kinds: ["video"] },
      { deviceId: "cam-b", mimeType: "video/VP8", kinds: ["video"] },
    ]);

    // 実行: 存在する kind に対して満たせない exact mimeType を指定する。
    let thrown: unknown;
    try {
      selectRegisterForKind(
        "video",
        { mimeType: { exact: "video/H264" } },
        candidates,
      );
    } catch (error) {
      thrown = error;
    }

    // 検証: WPT GUM-impossible-constraint と同様 OverconstrainedError.constraint。
    expect(thrown).toBeInstanceOf(OverconstrainedError);
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as OverconstrainedError).name).toBe("OverconstrainedError");
    expect((thrown as OverconstrainedError).constraint).toBe("mimeType");
  });

  test("duplicate mimeType picks the first registered candidate by default", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "first", mimeType: "video/VP8", kinds: ["video"] },
      { deviceId: "second", mimeType: "video/VP8", kinds: ["video"] },
    ]);

    // 実行: 同一 mimeType の 2 件から制約なしで 1 件選ぶ。
    const selected = selectRegisterForKind("video", true, candidates);

    // 検証: 同点なら登録順の先頭（UA デフォルト相当）。
    expect(selected.deviceId).toBe("first");
  });

  test("ideal mimeType prefers the matching register over registration order", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "first", mimeType: "video/VP8", kinds: ["video"] },
      { deviceId: "second", mimeType: "video/H264", kinds: ["video"] },
    ]);

    // 実行: ideal mimeType で fitness を付ける。
    const selected = selectRegisterForKind(
      "video",
      { mimeType: { ideal: "video/H264" } },
      candidates,
    );

    // 検証: 文字列制約の fitness は一致 0 / 不一致 1 なので ideal 側を選ぶ。
    expect(selected.deviceId).toBe("second");
  });

  test("deviceId.exact selects the unique register among duplicate mimeTypes", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "first", mimeType: "video/VP8", kinds: ["video"] },
      { deviceId: "second", mimeType: "video/VP8", kinds: ["video"] },
    ]);

    // 実行: 同一 mimeType でも deviceId.exact で一意化する。
    const selected = selectRegisterForKind(
      "video",
      { deviceId: { exact: "second" } },
      candidates,
    );

    // 検証: 必須 deviceId は fitness 無限大で他候補を落とす。
    expect(selected.deviceId).toBe("second");
  });

  test("unsupported required constraints such as width are ignored", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "cam", mimeType: "video/VP8", kinds: ["video"] },
    ]);

    // 実行: 未サポートの width.exact を付けたまま選択する。
    const selected = selectRegisterForKind(
      "video",
      { width: { exact: 1920 } } as never,
      candidates,
    );

    // 検証: 仕様どおり未サポート制約の fitness は 0 で無視する。
    expect(selected.deviceId).toBe("cam");
  });

  test("advanced constraint sets that cannot be satisfied are skipped", () => {
    const candidates = createPolyfillRegisterCandidates([
      { deviceId: "cam", mimeType: "video/VP8", kinds: ["video"] },
    ]);

    // 実行: 満たせない advanced を付けても basic だけで通ることを確認する。
    const selected = selectRegisterForKind(
      "video",
      {
        advanced: [{ mimeType: { exact: "video/H264" } }],
      },
      candidates,
    );

    // 検証: WPT GUM-optional-constraint と同様、optional は失敗しても取得できる。
    expect(selected.deviceId).toBe("cam");
  });
});

describe("polyfill existing mediaDevices install policy", () => {
  test("defaults to overwrite when mediaDevices already exists", () => {
    const existing = { getUserMedia: async () => undefined };

    // 実行: 既定モードで既存 mediaDevices がある場合の動作を決める。
    const action = shouldInstallMediaDevices(existing);

    // 検証: デフォルトは上書きインストール。
    expect(action).toBe("install");
  });

  test("noop skips install when mediaDevices already exists", () => {
    const existing = { getUserMedia: async () => undefined };

    // 実行: noop モードを指定する。
    const action = shouldInstallMediaDevices(existing, "noop");

    // 検証: 既存を残してインストールをスキップする。
    expect(action).toBe("skip");
  });

  test("throw rejects when mediaDevices already exists", () => {
    const existing = { getUserMedia: async () => undefined };

    // 実行: throw モードで既存 mediaDevices に衝突させる。
    let thrown: unknown;
    try {
      shouldInstallMediaDevices(existing, "throw");
    } catch (error) {
      thrown = error;
    }

    // 検証: 明示オプション時のみエラーにする。
    expect(thrown).toBeInstanceOf(Error);
  });
});

describe("OverconstrainedError", () => {
  test("is a DOMException subclass with constraint", () => {
    // 実行: WPT overconstrainederror.html と同じ構築をする。
    const error = new OverconstrainedError("width");

    // 検証: DOMException を継承し name と constraint を持つ。
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe("OverconstrainedError");
    expect(error.constraint).toBe("width");
  });
});
