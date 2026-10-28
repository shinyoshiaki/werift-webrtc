import {
  OPUS_FRAME_TICKS,
  SendAccounting,
} from "../../../mediachannel/latency_budget/sendRange.js";

// 送信側 transform が報告する範囲: 先頭 timestamp から frames 個 (20ms = 960 ticks)
const range = (firstRtpTimestamp: number, frames: number) => ({
  firstRtpTimestamp,
  lastRtpTimestamp: (firstRtpTimestamp + (frames - 1) * OPUS_FRAME_TICKS) >>> 0,
  frames,
});
const ts = (first: number, index: number) =>
  (first + index * OPUS_FRAME_TICKS) >>> 0;
const nack = (pending = 0, unrecovered = 0, late = 0) => ({
  pending,
  unrecovered,
  late,
});

describe("latency_budget SendAccounting", () => {
  test("先頭が落ちても、受信した 1 パケットと開始 timestamp から最初の seq を求める", () => {
    // Arrange: 送信は timestamp 1000 / seq 500 から。先頭 3 パケットが落ちる
    const accounting = new SendAccounting();
    accounting.start(1000);

    // Act: 4 パケット目 (seq 503) から届く
    const firstSeq = accounting.receive(503, ts(1000, 3));

    // Assert: 最初の seq は 500 (最初に受信した 503 ではない)
    expect(firstSeq).toBe(500);
  });

  test("開始通知より先に届いたパケットも、通知が来てから数える", () => {
    // Arrange: 開始通知が RTP より遅れて届く
    const accounting = new SendAccounting();
    expect(accounting.receive(11, ts(5000, 1))).toBeUndefined();

    // Act
    const firstSeq = accounting.start(5000);

    // Assert
    expect(firstSeq).toBe(10);
  });

  test("停止時の範囲から最後の seq を求め、16bit の折り返しをまたいでも対応が取れる", () => {
    // Arrange: seq 65534 から 5 フレーム (65534, 65535, 0, 1, 2)。timestamp も 32bit で折り返す
    const first = 0xffffffff - 960;
    const accounting = new SendAccounting();
    accounting.start(first);
    for (const [i, seq] of [65534, 65535, 0, 1, 2].entries()) {
      accounting.receive(seq, ts(first, i));
    }

    // Act
    const lastSeq = accounting.stop(range(first, 5));
    const summary = accounting.summary(nack());

    // Assert: 最後は seq 2。全て受信済みで釣り合っている
    expect(lastSeq).toBe(2);
    expect(summary).toMatchObject({
      status: "verified",
      uniqueReceived: 5,
      balanced: true,
    });
  });

  test("重複した再送は 1 回だけ数え、停止通知の後に初めて届いたパケットを数える", () => {
    // Arrange: 0..3 を送信。1 は重複して届き、3 は停止通知の後に届く
    const accounting = new SendAccounting();
    accounting.start(0);
    accounting.receive(100, ts(0, 0));
    accounting.receive(101, ts(0, 1));
    accounting.receive(101, ts(0, 1));
    accounting.receive(102, ts(0, 2));

    // Act
    accounting.stop(range(0, 4));
    accounting.receive(103, ts(0, 3));
    const summary = accounting.summary(nack());

    // Assert
    expect(summary).toMatchObject({
      status: "verified",
      uniqueReceived: 4,
      duplicates: 1,
      arrivedAfterStop: 1,
      balanced: true,
    });
  });

  test("届かなかったパケットは unrecovered - late と一致したときだけ釣り合う", () => {
    // Arrange: 0..4 を送信し、seq 2 だけが届かない
    const arrange = () => {
      const accounting = new SendAccounting();
      accounting.start(0);
      for (const i of [0, 1, 3, 4]) accounting.receive(10 + i, ts(0, i));
      accounting.stop(range(0, 5));
      return accounting;
    };

    // Act: NACK 側が 1 件を諦めた場合と、何も数えていない場合
    const counted = arrange().summary(nack(0, 1, 0));
    const uncounted = arrange().summary(nack(0, 0, 0));

    // Assert: 欠落を NACK が数えていなければ釣り合わない
    expect(counted.balanced).toBe(true);
    expect(counted.neverReceived).toBe(1);
    expect(uncounted.balanced).toBe(false);
  });

  test("範囲外のパケットや、seq と timestamp の対応が崩れたパケットがあれば unverified にする", () => {
    // Arrange
    const outside = new SendAccounting();
    outside.start(9600);
    outside.receive(10, ts(9600, 0));
    // 範囲より前 (先頭 timestamp より古い)
    outside.receive(9, ts(9600, -1));
    const mismatch = new SendAccounting();
    mismatch.start(0);
    mismatch.receive(10, ts(0, 0));
    // timestamp では 1 フレーム後なのに seq が 2 進んでいる
    mismatch.receive(12, ts(0, 1));

    // Act
    outside.stop(range(9600, 1));
    mismatch.stop(range(0, 2));

    // Assert
    expect(outside.summary(nack()).status).toBe("unverified");
    expect(outside.summary(nack()).outOfRange).toBe(1);
    expect(mismatch.summary(nack()).status).toBe("unverified");
    expect(mismatch.summary(nack()).mismatched).toBe(1);
  });

  test("フレーム数が timestamp の範囲と合わなければ (DTX など) 最後の seq を推定しない", () => {
    // Arrange: 10 フレーム分の timestamp 範囲に 8 フレームしか送っていない
    const accounting = new SendAccounting();
    accounting.start(0);
    accounting.receive(1, ts(0, 0));

    // Act
    const lastSeq = accounting.stop({
      firstRtpTimestamp: 0,
      lastRtpTimestamp: ts(0, 9),
      frames: 8,
    });

    // Assert
    expect(lastSeq).toBeUndefined();
    expect(accounting.summary(nack()).status).toBe("unverified");
    expect(accounting.summary(nack()).balanced).toBe(false);
  });
});
