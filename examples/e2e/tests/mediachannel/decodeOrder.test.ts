import { DecodeOrder } from "../../../mediachannel/latency_budget/decodeOrder.js";

describe("latency_budget DecodeOrder", () => {
  const arrange = (waiting: Set<number>) =>
    new DecodeOrder<number>((seq) => waiting.has(seq));

  test("欠番を待っている間は後続を保持し、再送が届いたら seq 順に出す", () => {
    // Arrange: seq 3 が欠番で、再送を待っている
    const waiting = new Set([3]);
    const order = arrange(waiting);
    const decoded: number[] = [];
    const feed = (seq: number) => decoded.push(...order.push(seq, seq).ready);

    // Act: 1, 2, 4, 5 の後に 3 (再送) が届く
    for (const seq of [1, 2, 4, 5]) feed(seq);
    const heldBefore = order.heldFrames;
    waiting.delete(3);
    feed(3);

    // Assert: 4, 5 は 3 が届くまで保持され、デコード順は 1..5 になる
    expect(heldBefore).toBe(2);
    expect(decoded).toEqual([1, 2, 3, 4, 5]);
  });

  test("欠番を諦めたら後続を出し、その後に届いた古いフレームはデコードしない", () => {
    // Arrange
    const waiting = new Set([3]);
    const order = arrange(waiting);
    order.push(1, 1);
    order.push(2, 2);
    order.push(4, 4);

    // Act: 期限切れで待つのをやめてから、3 が遅れて届く
    waiting.delete(3);
    const released = order.release();
    const late = order.push(3, 3);

    // Assert: 4 が出て、3 は late として捨てられる (デコーダの状態を巻き戻さない)
    expect(released).toEqual([4]);
    expect(late).toEqual({ ready: [], late: true });
  });

  test("16bit の折り返しをまたいでも seq 順に出す", () => {
    // Arrange: 65535 -> 0 の間の 0 が欠番
    const waiting = new Set([0]);
    const order = arrange(waiting);
    const decoded: number[] = [];
    const feed = (seq: number) => decoded.push(...order.push(seq, seq).ready);

    // Act
    for (const seq of [65534, 65535, 1, 2]) feed(seq);
    waiting.delete(0);
    feed(0);

    // Assert
    expect(decoded).toEqual([65534, 65535, 0, 1, 2]);
  });

  test("start で先頭の seq を伝えると、先頭が後から届いても最初に受信した seq から始めない", () => {
    // Arrange: 先頭 10 が落ち、11 が先に届く
    const waiting = new Set([10]);
    const order = arrange(waiting);
    const decoded: number[] = [];
    const feed = (seq: number) => decoded.push(...order.push(seq, seq).ready);

    // Act: 先頭が 10 だと伝え、11 の後に 10 の再送が届く
    order.start(10);
    feed(11);
    waiting.delete(10);
    feed(10);

    // Assert: 10 を捨てずに 10, 11 の順で出す
    expect(decoded).toEqual([10, 11]);
  });
});
