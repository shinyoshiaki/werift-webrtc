import { FifoQueue } from "../src";
import { createFilledQueue } from "./utils";

describe("FifoQueue", () => {
  test("keeps FIFO order across push / shift / unshift", () => {
    // Arrange
    const queue = createFilledQueue(3);

    // Act: 先頭を取り出して戻し、末尾に追加する
    const first = queue.shift();
    queue.unshift(first!);
    queue.push(3);

    // Assert: 順序と長さ・参照系 API が配列と同じ結果になる
    expect(queue.toArray()).toEqual([0, 1, 2, 3]);
    expect(queue.length).toBe(4);
    expect(queue.peek()).toBe(0);
    expect(queue.last()).toBe(3);
    expect(queue.at(1)).toBe(1);
    expect(queue.at(-1)).toBe(3);
    expect(queue.at(4)).toBeUndefined();
    expect(queue.findIndex((v) => v === 2)).toBe(2);
    expect(queue.filter((v) => v % 2 === 0).toArray()).toEqual([0, 2]);
  });

  test("indexes stay correct after compaction of a long queue", () => {
    // Arrange
    const count = 10_000;
    const queue = createFilledQueue(count);

    // Act: 半分以上取り出して内部の compaction を発生させる
    for (let i = 0; i < 6_000; i++) queue.shift();

    // Assert: 残りの要素に先頭から正しくアクセスできる
    expect(queue.length).toBe(4_000);
    expect(queue.peek()).toBe(6_000);
    expect(queue.at(3_999)).toBe(count - 1);
    expect([...queue]).toEqual([...Array(4_000).keys()].map((i) => i + 6_000));

    // Act: 全部取り出す
    while (queue.length) queue.shift();

    // Assert: 空になり、空からの shift は undefined
    expect(queue.shift()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
    expect(queue.last()).toBeUndefined();
  });

  test("iteration continues from the current front when elements are shifted meanwhile", () => {
    // Arrange
    const queue = createFilledQueue(5);
    const seen: number[] = [];

    // Act: 走査の途中で先頭を取り出す (await を挟んだ SACK 処理を模擬)
    for (const value of queue) {
      seen.push(value);
      if (value === 1) {
        queue.shift();
        queue.shift();
        queue.shift();
      }
    }

    // Assert: 生きている要素を飛ばさず、取り出し済みの要素は再訪しない
    expect(seen).toEqual([0, 1, 3, 4]);
  });

  test("shift stays linear for large queues", () => {
    // Arrange
    const measure = (count: number) => {
      const queue = createFilledQueue(count);
      const started = performance.now();
      while (queue.length) queue.shift();
      return performance.now() - started;
    };
    // 複数回の最小値を使い、GC やスケジューラによる揺れを除く
    const best = (count: number) =>
      Math.min(...Array.from({ length: 5 }, () => measure(count)));
    measure(100_000); // ウォームアップ

    // Act: N と 16N の全件 shift 時間を計測する
    const small = best(50_000);
    const large = best(800_000);

    // Assert: 線形なら約 16 倍、二次なら約 256 倍。両者の中間 (64) を境にする
    expect(large / Math.max(small, 0.5)).toBeLessThan(64);
  });
});
