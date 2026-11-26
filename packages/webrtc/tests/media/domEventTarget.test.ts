import { MediaStream, MediaStreamTrack } from "../../src/media/track";
import {
  enumerateSequences,
  nativeCase,
  resetsHandlerAfterNull,
  runSequence,
  weriftCases,
} from "./domEventTargetTestUtils";

describe("DomEventTarget matches the native EventTarget", () => {
  const sequences = enumerateSequences(3).filter(
    (sequence) => !resetsHandlerAfterNull(sequence),
  );

  test.each(weriftCases)("$name", (targetCase) => {
    // Arrange: 長さ 3 までの全操作列 × cancelable の有無。
    const mismatches: string[] = [];

    // Act: 同じ操作列を werift とネイティブの両方に適用して 2 回 dispatch する。
    for (const sequence of sequences) {
      for (const cancelable of [false, true]) {
        const actual = runSequence(targetCase, sequence, cancelable);
        const expected = runSequence(nativeCase, sequence, cancelable);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(
            `${sequence.join(",") || "(none)"} cancelable=${cancelable}: ` +
              `werift=${JSON.stringify(actual)} native=${JSON.stringify(expected)}`,
          );
        }
      }
    }

    // Assert: 戻り値・defaultPrevented・呼び出し順・回数・this・Event がすべて一致する。
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(sequences.length).toBeGreaterThan(2000);
  });
});

describe("DomEventTarget behavior outside the native comparison", () => {
  test.each(weriftCases)(
    "$name: a throwing listener or handler is isolated",
    (targetCase) => {
      // Arrange: 関数・handleEvent オブジェクト・ハンドラ属性がそれぞれ投げる。
      const { target, type } = targetCase.create();
      const calls: string[] = [];
      target.addEventListener(type, () => {
        calls.push("fn");
        throw new Error("fn failed");
      });
      target.addEventListener(type, {
        handleEvent() {
          calls.push("obj");
          throw new Error("obj failed");
        },
      });
      target[`on${type}`] = () => {
        calls.push("handler");
        throw new Error("handler failed");
      };
      target.addEventListener(type, () => calls.push("last"));

      // Act
      const act = () => target.dispatchEvent(new Event(type));

      // Assert: 例外は呼び出し元に伝わらず（DOM は報告のみ）、後続の listener も呼ばれる。
      expect(act).not.toThrow();
      expect(calls).toEqual(["fn", "obj", "handler", "last"]);
    },
  );

  test.each(weriftCases)(
    "$name: a handler returning false cancels",
    (targetCase) => {
      // Arrange: HTML の event handler processing では false を返すと cancel される
      // （ブラウザの挙動。Node のネイティブ実装は未対応なので比較対象から外している）。
      const { target, type } = targetCase.create();
      target[`on${type}`] = () => false;

      // Act
      const cancelable = target.dispatchEvent(
        new Event(type, { cancelable: true }),
      );
      const notCancelable = target.dispatchEvent(new Event(type));

      // Assert
      expect(cancelable).toBe(false);
      expect(notCancelable).toBe(true);
    },
  );

  test.each([nativeCase, ...weriftCases])(
    "$name: signal removes the listener",
    (targetCase) => {
      // Arrange: 後で abort する signal と、登録前に abort 済みの signal。
      const { target, type } = targetCase.create();
      const controller = new AbortController();
      const calls: string[] = [];
      target.addEventListener(type, () => calls.push("live"), {
        signal: controller.signal,
      });
      target.addEventListener(type, () => calls.push("aborted"), {
        signal: AbortSignal.abort(),
      });

      // Act: abort 前後で 1 回ずつ dispatch する。
      target.dispatchEvent(new Event(type));
      controller.abort();
      target.dispatchEvent(new Event(type));

      // Assert: abort 前だけ呼ばれ、abort 済み signal の listener は登録されない。
      expect(calls).toEqual(["live"]);
    },
  );

  test.each(weriftCases)(
    "$name: a handler set again after null runs last (HTML order)",
    (targetCase) => {
      // Arrange: H1 → listener A → null → H2 の順に設定する。
      const { target, type } = targetCase.create();
      const calls: string[] = [];
      target[`on${type}`] = () => calls.push("H1");
      target.addEventListener(type, () => calls.push("A"));
      target[`on${type}`] = null;
      target[`on${type}`] = () => calls.push("H2");

      // Act
      target.dispatchEvent(new Event(type));

      // Assert: null で listener が外れるため、H2 は A の後に追加される。
      expect(calls).toEqual(["A", "H2"]);
    },
  );

  test("stop dispatches ended once even if onended throws, and the EventEmitter API still works", () => {
    // Arrange: EventEmitter の on と DOM の onended を両方使う。
    const track = new MediaStreamTrack({ kind: "audio" });
    const calls: string[] = [];
    track.on("ended", () => calls.push("on"));
    track.onended = () => {
      calls.push("onended");
      throw new Error("onended failed");
    };

    // Act: 2 回停止する。
    const act = () => {
      track.stop();
      track.stop();
    };

    // Assert: 例外は伝わらず、どちらも 1 回だけ呼ばれて track は ended になる。
    expect(act).not.toThrow();
    expect(calls).toEqual(["on", "onended"]);
    expect(track.readyState).toBe("ended");
  });

  test("handler attributes passed to the constructor are registered", () => {
    // Arrange / Act: props の Object.assign でハンドラ属性を設定する。
    const calls: string[] = [];
    const track = new MediaStreamTrack({
      kind: "video",
      onmute: () => calls.push("mute"),
    });
    const stream = new MediaStream({
      onaddtrack: () => calls.push("addtrack"),
    });
    track.dispatchEvent(new Event("mute"));
    stream.dispatchEvent(new Event("addtrack"));

    // Assert
    expect(calls).toEqual(["mute", "addtrack"]);
  });
});
