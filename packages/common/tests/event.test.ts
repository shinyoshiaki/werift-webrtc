import { describe, expect, test } from "vitest";

import { Event } from "../src/event";

describe("Event.executeIsolated", () => {
  test("先に登録した購読者が例外を投げても、後の購読者はすべて実行される", () => {
    // Arrange: 1 番目の購読者は例外を投げる
    const event = new Event<[number]>();
    const received: number[] = [];
    const errors: unknown[] = [];
    event.subscribe(() => {
      throw new Error("listener failed");
    });
    event.subscribe((value) => received.push(value));
    event.subscribe((value) => received.push(value * 10));

    // Act: 購読者ごとに隔離して通知する
    event.executeIsolated((error) => errors.push(error), 1);

    // Assert: 後の購読者は実行され、例外は onError に 1 回だけ渡る
    expect(received).toEqual([1, 10]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("listener failed");
  });

  test("execute() は従来どおり例外で反復を止めて呼び出し元へ伝える", () => {
    // Arrange
    const event = new Event<[]>();
    const later = vi.fn();
    event.subscribe(() => {
      throw new Error("listener failed");
    });
    event.subscribe(later);

    // Act / Assert: execute() は例外を投げ、後の購読者は実行されない（既存の挙動）
    expect(() => event.execute()).toThrow("listener failed");
    expect(later).not.toHaveBeenCalled();
  });

  test("complete 後の executeIsolated は何もしない", () => {
    // Arrange
    const event = new Event<[]>();
    const listener = vi.fn();
    event.subscribe(listener);
    event.complete();

    // Act: 終了後に通知する
    event.executeIsolated(() => undefined);

    // Assert: 購読者は呼ばれない
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Event.executeUntil", () => {
  test("停止の述語が true になったら、残りの購読者は呼ばない", () => {
    // Arrange: 2 番目の購読者が停止を指示する
    const event = new Event<[number]>();
    const received: string[] = [];
    let stopped = false;
    event.subscribe(() => received.push("first"));
    event.subscribe(() => {
      received.push("second");
      stopped = true;
    });
    event.subscribe(() => received.push("third"));

    // Act: 購読者ごとに停止を確認しながら通知する
    event.executeUntil(
      () => stopped,
      () => undefined,
      1,
    );

    // Assert: 停止を指示した購読者までが呼ばれる
    expect(received).toEqual(["first", "second"]);
  });

  test("購読者の例外は onError に渡し、停止していなければ次の購読者を呼ぶ", () => {
    // Arrange: 1 番目は例外、2 番目は例外の後に停止を指示する
    const event = new Event<[]>();
    const received: string[] = [];
    const errors: unknown[] = [];
    let stopped = false;
    event.subscribe(() => {
      throw new Error("listener failed");
    });
    event.subscribe(() => {
      received.push("second");
      stopped = true;
      throw new Error("after stop");
    });
    event.subscribe(() => received.push("third"));

    // Act
    event.executeUntil(
      () => stopped,
      (error) => errors.push(error),
    );

    // Assert: 例外は 2 件とも onError に渡り、停止後の購読者は呼ばれない
    expect(received).toEqual(["second"]);
    expect(errors.map(String)).toEqual([
      "Error: listener failed",
      "Error: after stop",
    ]);
  });

  test("通知中に解除された購読者は呼ばず、追加された購読者はその通知では呼ばない", () => {
    // Arrange: 1 番目が 2 番目を解除し、新しい購読者を追加する
    const event = new Event<[]>();
    const received: string[] = [];
    const second = { unSubscribe: () => {} };
    event.subscribe(() => {
      received.push("first");
      second.unSubscribe();
      event.subscribe(() => received.push("added"));
    });
    second.unSubscribe = event.subscribe(() =>
      received.push("second"),
    ).unSubscribe;
    event.subscribe(() => received.push("third"));

    // Act
    event.executeUntil(
      () => false,
      () => undefined,
    );

    // Assert: 解除された 2 番目と追加された購読者は呼ばれない
    expect(received).toEqual(["first", "third"]);
  });

  test("complete 後の executeUntil は何もしない", () => {
    // Arrange
    const event = new Event<[]>();
    const listener = vi.fn();
    event.subscribe(listener);
    event.complete();

    // Act: 終了後に通知する
    event.executeUntil(
      () => false,
      () => undefined,
    );

    // Assert: 購読者は呼ばれない
    expect(listener).not.toHaveBeenCalled();
  });
});
