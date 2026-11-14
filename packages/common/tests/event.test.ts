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
