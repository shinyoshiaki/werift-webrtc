import {
  RtpContinuityRewriter,
  timestampStepFromElapsed,
} from "../../src/rtp/continuity";
import type { RtpPacket } from "../../src/rtp/rtp";
import { createFramePackets, createRtpPacket } from "../utils";

const headersOf = (packets: RtpPacket[]) =>
  packets.map(({ header }) => ({
    sequenceNumber: header.sequenceNumber,
    timestamp: header.timestamp,
  }));

describe("rtp/continuity RtpContinuityRewriter", () => {
  test("最初のソースはそのまま通し、同一 timestamp の複数パケットを保つ", () => {
    // Arrange: 1 フレーム 3 パケットの映像列
    const rewriter = new RtpContinuityRewriter();
    const input = createFramePackets({
      startSequenceNumber: 100,
      startTimestamp: 9000,
      frames: 2,
      packetsPerFrame: 3,
    });

    // Act: すべて書き換える
    const output = input.map((p) => rewriter.rewrite(p));

    // Assert: 初回はオフセット 0 で、同一フレームの timestamp は共有されたまま
    expect(headersOf(output)).toEqual(headersOf(input));
    expect(rewriter.state).toMatchObject({
      highestOutputSequenceNumber: 105,
      highestOutputTimestamp: 12000,
      seqOffset: 0,
      timestampOffset: 0,
      generation: 0,
    });
  });

  test("切替後の先頭パケットで固定オフセットを確定し、フレーム構造を保つ", () => {
    // Arrange: 旧ソースを出力済みにし、新ソースのフレーム列を用意する
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(500, 50000));
    const next = createFramePackets({
      startSequenceNumber: 7,
      startTimestamp: 1234,
      frames: 2,
      packetsPerFrame: 2,
    });

    // Act: 切替を予約し新ソースを書き換える
    rewriter.switchSource();
    const output = next.map((p) => rewriter.rewrite(p));

    // Assert: 先頭は直前 +1 / ts +1、以後は固定オフセット
    expect(headersOf(output)).toEqual([
      { sequenceNumber: 501, timestamp: 50001 },
      { sequenceNumber: 502, timestamp: 50001 },
      { sequenceNumber: 503, timestamp: 53001 },
      { sequenceNumber: 504, timestamp: 53001 },
    ]);
    expect(rewriter.state.pending).toBeUndefined();
    expect(rewriter.state.generation).toBe(1);
  });

  test("欠落・重複・再順序はオフセットを変えずにそのまま写像する", () => {
    // Arrange: 切替済みの rewriter
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(10, 1000));
    rewriter.switchSource({ timestampStep: 3000 });
    rewriter.rewrite(createRtpPacket(200, 90000));

    // Act: 欠落 (202 飛ばし)、重複 (203 x2)、再順序 (201 が後着) を流す
    const output = [203, 203, 201, 204].map((seq) =>
      rewriter.rewrite(createRtpPacket(seq, 90000 + (seq - 200) * 3000)),
    );

    // Assert: 各パケットは同じ固定オフセットで写像される
    expect(headersOf(output)).toEqual([
      { sequenceNumber: 14, timestamp: 13000 },
      { sequenceNumber: 14, timestamp: 13000 },
      { sequenceNumber: 12, timestamp: 7000 },
      { sequenceNumber: 15, timestamp: 16000 },
    ]);
    // Assert: 最大出力は再順序パケットで後退しない
    expect(rewriter.state.highestOutputSequenceNumber).toBe(15);
    expect(rewriter.state.highestOutputTimestamp).toBe(16000);
  });

  test("切替直前に再順序で古いパケットが流れても既出 seq と衝突しない", () => {
    // Arrange: 100, 101, 102 の後に再順序の 99 が最後に出力される
    const rewriter = new RtpContinuityRewriter();
    const sent = [100, 101, 102, 99].map((seq) =>
      rewriter.rewrite(createRtpPacket(seq, seq * 10)),
    );

    // Act: 切替して新ソースの先頭を流す
    rewriter.switchSource();
    const first = rewriter.rewrite(createRtpPacket(5000, 77));

    // Assert: 「最後の出力 +1 (=100)」ではなく「最大出力 +1 (=103)」になる
    expect(sent.map((p) => p.header.sequenceNumber)).toContain(100);
    expect(first.header.sequenceNumber).toBe(103);
    expect(first.header.timestamp).toBe(1021);
  });

  test("timestamp は seq と独立に最大出力を追跡する (B フレーム)", () => {
    // Arrange: seq は進むが timestamp が戻る B フレーム順
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(1, 9000));
    rewriter.rewrite(createRtpPacket(2, 3000));

    // Act: 切替後の先頭を流す
    rewriter.switchSource();
    const out = rewriter.rewrite(createRtpPacket(0, 0));

    // Assert: 最大 ts (9000) から +1、最大 seq (2) から +1
    expect(out.header.sequenceNumber).toBe(3);
    expect(out.header.timestamp).toBe(9001);
  });

  test("seq 0xffff / ts 0xffffffff の wrap を跨いでも連続する", () => {
    // Arrange: wrap 直前まで出力し、切替後の新ソースも wrap 近傍にする
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(0xfffe, 0xfffffffe));
    rewriter.rewrite(createRtpPacket(0xffff, 0xffffffff));
    const next = createFramePackets({
      startSequenceNumber: 0xfffe,
      startTimestamp: 0xffffff00,
      frames: 3,
      timestampStep: 0x100,
    });

    // Act: 切替して wrap を跨ぐ列を流す
    rewriter.switchSource({ timestampStep: 2 });
    const output = next.map((p) => rewriter.rewrite(p));

    // Assert: seq は 0 から、ts は 1 から 0x100 刻み
    expect(headersOf(output)).toEqual([
      { sequenceNumber: 0, timestamp: 1 },
      { sequenceNumber: 1, timestamp: 0x101 },
      { sequenceNumber: 2, timestamp: 0x201 },
    ]);
    // Assert: 最大出力は wrap 後の値で更新される
    expect(rewriter.state.highestOutputSequenceNumber).toBe(2);
    expect(rewriter.state.highestOutputTimestamp).toBe(0x201);
  });

  test("連続した複数回の切替で世代ごとにオフセットを再確定する", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(10, 100));
    const outputs: RtpPacket[] = [];

    // Act: A → B → C と切り替えて各 2 パケット流す
    for (const [seq, ts] of [
      [3000, 70000],
      [60000, 5],
    ]) {
      rewriter.switchSource();
      outputs.push(rewriter.rewrite(createRtpPacket(seq, ts)));
      outputs.push(rewriter.rewrite(createRtpPacket(seq + 1, ts + 960)));
    }

    // Assert: 下流は 11..14 と途切れず、ts も連続する
    expect(headersOf(outputs)).toEqual([
      { sequenceNumber: 11, timestamp: 101 },
      { sequenceNumber: 12, timestamp: 1061 },
      { sequenceNumber: 13, timestamp: 1062 },
      { sequenceNumber: 14, timestamp: 2022 },
    ]);
    expect(rewriter.state.generation).toBe(2);
  });

  test("確定前に switchSource を複数回呼ぶと最後の timestampStep が勝つ", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(1, 1000));

    // Act: 確定前に 2 回予約する
    rewriter.switchSource({ timestampStep: 3000 });
    rewriter.switchSource({ timestampStep: 960 });
    const out = rewriter.rewrite(createRtpPacket(50, 0));

    // Assert: seq は 1 つだけ進み、ts は最後の step
    expect(out.header.sequenceNumber).toBe(2);
    expect(out.header.timestamp).toBe(1960);
  });

  test("cancelPendingSwitch は未確定の切替を取り消す", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(1, 1000));
    rewriter.switchSource();

    // Act: 取り消してから次のパケットを流す
    rewriter.cancelPendingSwitch();
    const out = rewriter.rewrite(createRtpPacket(50, 0));

    // Assert: オフセットは確定されず、従来のオフセット (0) のまま
    expect(rewriter.state.pending).toBeUndefined();
    expect(out.header.sequenceNumber).toBe(50);
    expect(out.header.timestamp).toBe(0);
  });

  test("state を別インスタンスへ復元すると出力タイムラインを引き継ぐ", () => {
    // Arrange: 出力済み・切替予約済みの state を取り出す
    const first = new RtpContinuityRewriter();
    first.rewrite(createRtpPacket(300, 30000));
    first.switchSource({ timestampStep: 10 });
    const state = first.state;

    // Act: 新しいインスタンスへ復元して流す
    const restored = new RtpContinuityRewriter({ state });
    const out = restored.rewrite(createRtpPacket(9, 9));

    // Assert: 復元側でも連続し、元の state はコピーなので変化しない
    expect(out.header.sequenceNumber).toBe(301);
    expect(out.header.timestamp).toBe(30010);
    expect(state.pending).toEqual({ timestampStep: 10 });
    expect(restored.toJSON()).toMatchObject({ generation: 1, ssrc: undefined });
  });

  test("reset は出力タイムラインを破棄し、次の入力をそのまま通す", () => {
    // Arrange: オフセットが付いた状態にする
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(1, 1));
    rewriter.switchSource();
    rewriter.rewrite(createRtpPacket(100, 100));

    // Act
    rewriter.reset();
    const out = rewriter.rewrite(createRtpPacket(700, 7000));

    // Assert: 新しい世代はオフセット 0
    expect(out.header.sequenceNumber).toBe(700);
    expect(out.header.timestamp).toBe(7000);
    expect(rewriter.state).toMatchObject({
      seqOffset: 0,
      timestampOffset: 0,
      generation: 2,
    });
  });

  test("rewrite は入力を変更せず、ssrc 指定時だけ SSRC を書き換える", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter({ ssrc: 0xabcdef01 });
    rewriter.rewrite(createRtpPacket(1, 1));
    rewriter.switchSource();
    const input = createRtpPacket(500, 500, { ssrc: 0x22222222 });

    // Act
    const out = rewriter.rewrite(input);

    // Assert: 入力ヘッダーは元のまま、出力は別オブジェクト (payload は共有)
    expect(input.header.sequenceNumber).toBe(500);
    expect(input.header.timestamp).toBe(500);
    expect(input.header.ssrc).toBe(0x22222222);
    expect(out).not.toBe(input);
    expect(out.header).not.toBe(input.header);
    expect(out.payload).toBe(input.payload);
    expect(out.header.ssrc).toBe(0xabcdef01);
    expect(out.header.sequenceNumber).toBe(2);
  });

  test("ssrc 未指定なら SSRC を保持し、rewriteHeaderInPlace は header を直接書き換える", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(1, 1));
    rewriter.switchSource();
    const packet = createRtpPacket(40, 40, { ssrc: 0x33333333 });

    // Act
    rewriter.rewriteHeaderInPlace(packet.header);

    // Assert
    expect(packet.header.sequenceNumber).toBe(2);
    expect(packet.header.timestamp).toBe(2);
    expect(packet.header.ssrc).toBe(0x33333333);
  });

  test("translate は現世代のオフセットで入力値を写像する (RTX OSN / SR 用)", () => {
    // Arrange
    const rewriter = new RtpContinuityRewriter();
    rewriter.rewrite(createRtpPacket(0xffff, 0xffffffff));
    rewriter.switchSource();
    rewriter.rewrite(createRtpPacket(10, 100));

    // Act / Assert: 確定済みオフセットで wrap 込みの写像になる
    expect(rewriter.translateSequenceNumber(12)).toBe(2);
    expect(rewriter.translateTimestamp(160)).toBe(60);
  });
});

describe("rtp/continuity timestampStepFromElapsed", () => {
  test("経過時間を clockRate で timestamp 増分に変換し、最小 1 を返す", () => {
    // Act / Assert: 33ms@90kHz → 2970、0 以下や非有限は 1
    expect(timestampStepFromElapsed(33, 90000)).toBe(2970);
    expect(timestampStepFromElapsed(20, 48000)).toBe(960);
    expect(timestampStepFromElapsed(0, 90000)).toBe(1);
    expect(timestampStepFromElapsed(Number.NaN, 90000)).toBe(1);
    // Act / Assert: 不正な clockRate は RangeError
    expect(() => timestampStepFromElapsed(10, 0)).toThrow(RangeError);
  });
});
