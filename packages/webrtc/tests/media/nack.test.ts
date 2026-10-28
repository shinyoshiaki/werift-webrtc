/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-var */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GenericNack,
  type RtcpPacket,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
} from "../../../rtp/src";
import { NackHandler, type NackOptions } from "../../src/media/receiver/nack";
import { createNackAudioReceiver } from "../fixture";

describe("media/nack", () => {
  test("16bit rotate", () => {
    const nack = new NackHandler(new MockRTCRtpReceiver() as any);
    let packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 65535, ssrc: 1 }),
      Buffer.from(""),
    );
    nack.addPacket(packet);

    packet = new RtpPacket(
      new RtpHeader({ sequenceNumber: 3, ssrc: 1 }),
      Buffer.from(""),
    );
    nack.addPacket(packet);

    expect(nack.lostSeqNumbers).toEqual([0, 1, 2]);
  });
});

describe("media/nack retry policy", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const arrange = (options: NackOptions = {}) => {
    vi.useFakeTimers();
    const receiver = new MockRTCRtpReceiver();
    const nack = new NackHandler(receiver as any, options);
    const add = (seq: number) =>
      nack.addPacket(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: seq, ssrc: 1 }),
          Buffer.from(""),
        ),
      );
    return { nack, receiver, add };
  };

  test("既定値は従来どおり約 50ms (10 回強の NACK) で諦める", () => {
    const { nack, receiver, add } = arrange();
    add(10);
    add(12);

    // Act: 5ms 間隔の NACK を 100ms 分進める
    vi.advanceTimersByTime(100);

    // Assert: 11 回 NACK した後に諦め、unrecovered に数える
    expect(receiver.nackedSeqs.filter((seq) => seq === 11)).toHaveLength(11);
    expect(nack.lostSeqNumbers).toEqual([]);
    expect(nack.stats).toEqual({
      lost: 1,
      recovered: 0,
      unrecovered: 1,
      pending: 0,
    });
    nack.close();
  });

  test("maxWaitMs の間は retryIntervalMs ごとに NACK を続ける", () => {
    const { nack, receiver, add } = arrange({
      maxWaitMs: 5000,
      retryIntervalMs: 100,
    });
    add(10);
    add(12);

    // Act: 従来の打ち切り (50ms) を大きく超えて 4 秒進める
    vi.advanceTimersByTime(4000);

    // Assert: まだ諦めず、100ms 間隔で NACK している
    expect(nack.lostSeqNumbers).toEqual([11]);
    const count = receiver.nackedSeqs.filter((seq) => seq === 11).length;
    expect(count).toBeGreaterThanOrEqual(39);
    expect(count).toBeLessThanOrEqual(41);

    // Act: 再送が budget 内に届く
    add(11);

    // Assert: recovered に数えて追跡をやめる
    expect(nack.stats).toEqual({
      lost: 1,
      recovered: 1,
      unrecovered: 0,
      pending: 0,
    });
    nack.close();
  });

  test("maxWaitMs を過ぎたパケットは諦める", () => {
    const { nack, add } = arrange({ maxWaitMs: 300, retryIntervalMs: 20 });
    add(1);
    add(4);

    // Act: budget を過ぎるまで進める
    vi.advanceTimersByTime(299);
    const before = nack.lostSeqNumbers;
    vi.advanceTimersByTime(30);

    // Assert: budget 内は追跡し、過ぎたら unrecovered になる
    expect(before).toEqual([2, 3]);
    expect(nack.lostSeqNumbers).toEqual([]);
    expect(nack.stats.unrecovered).toBe(2);
    nack.close();
  });

  test("maxWaitMs=0 は NACK を送らず即座に unrecovered にする", () => {
    const { nack, receiver, add } = arrange({ maxWaitMs: 0 });
    add(1);
    add(3);

    // Act
    vi.advanceTimersByTime(100);

    // Assert: NACK は一度も送らない
    expect(receiver.nackedSeqs).toEqual([]);
    expect(nack.stats).toEqual({
      lost: 1,
      recovered: 0,
      unrecovered: 1,
      pending: 0,
    });
    nack.close();
  });

  test("setOptions は待機中のパケットにも新しい budget を適用する", () => {
    const { nack, add } = arrange({ maxWaitMs: 5000, retryIntervalMs: 50 });
    add(1);
    add(3);
    vi.advanceTimersByTime(200);

    // Act: 実行中に budget を 100ms に縮める
    nack.setOptions({ maxWaitMs: 100, retryIntervalMs: 50 });
    vi.advanceTimersByTime(60);

    // Assert: 既に 200ms 待っているので諦める
    expect(nack.lostSeqNumbers).toEqual([]);
    expect(nack.stats.unrecovered).toBe(1);
    nack.close();
  });

  test("maxLost を超えた古い欠番は unrecovered として捨てる", () => {
    const { nack, add } = arrange({ maxWaitMs: 5000, maxLost: 3 });
    add(1);

    // Act: 5 個まとめて欠落させる
    add(7);

    // Assert: 新しい 3 個だけ追跡する
    expect(nack.lostSeqNumbers).toEqual([4, 5, 6]);
    expect(nack.stats.unrecovered).toBe(2);
    nack.close();
  });

  test.each([
    { maxLost: undefined, label: "既定 (150 件)" },
    { maxLost: 300, label: "5 秒 budget 相当 (300 件)" },
  ])("4 秒 (200 パケット) の連続ロスを $label で追跡する", ({ maxLost }) => {
    // Arrange: 5 秒 budget。20ms Opus の欠番が 200 個 (4 秒) 連続する
    const { nack, add } = arrange({
      maxWaitMs: 5000,
      retryIntervalMs: 20,
      maxLost,
    });
    add(1000);
    add(1201);
    vi.advanceTimersByTime(1000);

    // Act: 再送されたパケットを budget 内に全て届ける
    for (let seq = 1001; seq <= 1200; seq++) add(seq);

    // Assert: 追跡上限が足りれば全て回収し、既定値では古い欠番が追跡から外れる
    expect(nack.stats.lost).toBe(200);
    if (maxLost === undefined) {
      expect(nack.stats.recovered).toBe(150);
      expect(nack.stats.unrecovered).toBe(50);
    } else {
      expect(nack.stats.recovered).toBe(200);
      expect(nack.stats.unrecovered).toBe(0);
    }
    expect(nack.stats.pending).toBe(0);
    nack.close();
  });

  test("実行中に maxLost を小さくすると、追跡中の欠番も新しい上限まで整理する", () => {
    // Arrange: 上限 300 で 200 個の欠番を追跡する
    const { nack, receiver, add } = arrange({ maxWaitMs: 5000, maxLost: 300 });
    add(1000);
    add(1201);
    expect(nack.stats.pending).toBe(200);

    // Act: 上限を 100 に下げる
    nack.setOptions({ maxWaitMs: 5000, maxLost: 100 });
    receiver.nackedSeqs.length = 0;
    vi.advanceTimersByTime(100);

    // Assert: 古い 100 個は打ち切られ、新しい 100 個だけが追跡・NACK される
    expect(nack.stats.pending).toBe(100);
    expect(nack.stats.unrecovered).toBe(100);
    expect(nack.lostSeqNumbers[0]).toBe(1101);
    expect(Math.min(...receiver.nackedSeqs)).toBe(1101);
    nack.close();
  });
});

describe("media/rtpReceiver audio NACK", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const nackedSeqs = (sendRtcp: ReturnType<typeof vi.fn>) =>
    sendRtcp.mock.calls.flatMap(([packets]) =>
      (packets as RtcpPacket[]).flatMap((packet) =>
        packet instanceof RtcpTransportLayerFeedback &&
        packet.feedback instanceof GenericNack
          ? packet.feedback.lost
          : [],
      ),
    );

  test("audio codec が nack を negotiate していれば音声も NACK する", () => {
    vi.useFakeTimers();
    const { receiver, sendRtcp, receive, received } = createNackAudioReceiver({
      config: { nack: { maxWaitMs: 1000, retryIntervalMs: 10 } },
    });

    // Act: 欠番を作って NACK を回し、再送で埋める
    receive(100);
    receive(102);
    vi.advanceTimersByTime(25);
    receive(101);

    // Assert: 音声の欠番 101 を NACK し、回収したパケットを track に流す
    expect(nackedSeqs(sendRtcp as any)).toContain(101);
    expect(received).toEqual([100, 102, 101]);
    expect(receiver.nackStats).toMatchObject({ lost: 1, recovered: 1 });
    receiver.stop();
  });

  test("nack が無い (既定の) 音声 codec は NACK しない", () => {
    vi.useFakeTimers();
    const { receiver, sendRtcp, receive } = createNackAudioReceiver({
      rtcpFeedback: [{ type: "transport-cc" }],
    });

    // Act
    receive(100);
    receive(102);
    vi.advanceTimersByTime(100);

    // Assert: 既定挙動は変わらない
    expect(nackedSeqs(sendRtcp as any)).toEqual([]);
    expect(receiver.nackStats.lost).toBe(0);
    receiver.stop();
  });

  test("音声は nack pli だけでは NACK しない", () => {
    vi.useFakeTimers();
    const { receiver, sendRtcp, receive } = createNackAudioReceiver({
      rtcpFeedback: [{ type: "nack", parameter: "pli" }],
    });

    // Act
    receive(100);
    receive(102);
    vi.advanceTimersByTime(100);

    // Assert: generic nack ではないので対象外
    expect(nackedSeqs(sendRtcp as any)).toEqual([]);
    receiver.stop();
  });

  test("setNackOptions で受信中に budget を変えられる", () => {
    vi.useFakeTimers();
    const { receiver, receive } = createNackAudioReceiver();

    // Act: 既定 (約 50ms) から 5 秒 budget に変更してから欠落させる
    receiver.setNackOptions({ maxWaitMs: 5000, retryIntervalMs: 100 });
    receive(1);
    receive(3);
    vi.advanceTimersByTime(1000);

    // Assert: 1 秒経っても再送を待ち続けている
    expect(receiver.nackStats.pending).toBe(1);
    receiver.stop();
  });
});

class MockRTCRtpReceiver {
  rtcpSsrc = 0;
  nackedSeqs: number[] = [];
  dtlsTransport = {
    sendRtcp: async (packets: RtcpPacket[]) => {
      for (const packet of packets) {
        if (
          packet instanceof RtcpTransportLayerFeedback &&
          packet.feedback instanceof GenericNack
        ) {
          this.nackedSeqs.push(...packet.feedback.lost);
        }
      }
    },
  };
  sendRtcpPLI = () => {};
}
