import { SubscriptionStart } from "../../../mediachannel/latency_budget/subscriptionStart.js";
import { Unwrapper } from "../../../mediachannel/latency_budget/unwrap.js";

describe("latency_budget Unwrapper", () => {
  test("16bit の seq を、半周・一周を超えても増え続ける値に伸ばす", () => {
    // Arrange: 65000 から始める
    const seqs = new Unwrapper(16);

    // Act: 3 周分 (約 20 万) を順に入れる
    const extended = Array.from({ length: 200_000 }, (_, i) =>
      seqs.unwrap((65000 + i) & 0xffff),
    );

    // Assert: 最初が 0 で、1 ずつ増える
    expect(extended.every((v, i) => v === i)).toBe(true);
  });

  test("最新より古い値は負方向に伸ばし、基準を戻さない。peek は基準を動かさない", () => {
    // Arrange
    const ts = new Unwrapper(32);
    ts.unwrap(0xffffff00);

    // Act / Assert: 32bit の折り返しをまたいで進み、古い値は手前に置かれる
    expect(ts.unwrap(0x100)).toBe(0x200);
    expect(ts.unwrap(0xfffffe00)).toBe(-0x100);
    expect(ts.peek(0x300)).toBe(0x400);
    expect(ts.unwrap(0x200)).toBe(0x300);
  });
});

describe("latency_budget SubscriptionStart", () => {
  test("購読開始から 32768 パケットを超え、一周を超えても新しいパケットを購読前と判定しない", () => {
    // Arrange: seq 100 から購読が始まる
    const subscription = new SubscriptionStart();
    expect(subscription.accept(100, 0)).toBe("start");

    // Act: 続く 14 万パケット (2 周強) を順に中継する
    const decisions = Array.from({ length: 140_000 }, (_, i) =>
      subscription.accept((101 + i) & 0xffff, (i + 1) * 960),
    );

    // Assert: 1 つも破棄しない
    expect(decisions.filter((d) => d !== "relay")).toEqual([]);
  });

  test("upstream で回収した購読開始前のパケットは、開始にも中継にもしない", () => {
    // Arrange: upstream の最新は 110
    const subscription = new SubscriptionStart();

    // Act: 購読直後に回収した 100 が先に来て、その後 111 から届く
    const recovered = subscription.accept(100, 0, 110);
    const first = subscription.accept(111, 0, 111);
    const older = subscription.accept(105, 0, 111);

    // Assert: 開始は 111。開始より古い 100 / 105 は購読前として破棄する
    expect(recovered).toBe("before");
    expect(first).toBe("start");
    expect(subscription.start?.sequenceNumber).toBe(111);
    expect(older).toBe("before");
  });

  test("開始後に upstream で回収された、開始より新しい欠番は中継する", () => {
    // Arrange
    const subscription = new SubscriptionStart();
    subscription.accept(65535, 0);
    subscription.accept(2, 0);

    // Act: 折り返しをまたいだ欠番 0, 1 が後から届く
    const decisions = [0, 1].map((seq) => subscription.accept(seq, 0));

    // Assert
    expect(decisions).toEqual(["relay", "relay"]);
  });
});
