import { describe, expect, test, vi } from "vitest";
import {
  PacketStatus,
  RtcpPacketConverter,
  type RtcpTransportLayerFeedback,
  type TransportWideCC,
} from "../../src";
import {
  acquireTransportReceiverTWCC,
  ReceiverTWCC,
} from "../../src/media/receiver/receiverTwcc";

// 欠番の未受信報告・feedback 境界をまたぐ報告・16-bit wrap は tests/pbt/receiver の性質テストで確かめる。
describe("ReceiverTWCC", () => {
  function makeReceiver() {
    const dtls = {
      sendRtcp: vi.fn(async (_packets: unknown[]) => {}),
    };
    const rx = new ReceiverTWCC(dtls as any, 1, 2);
    // Unit tests drive sendTWCC explicitly; stop periodic loop races.
    rx.twccRunning = false;
    return { rx, dtls };
  }

  test("constructor で twccRunning=true（100ms 周期が起動する）", () => {
    const dtls = { sendRtcp: vi.fn(async () => {}) };
    const rx = new ReceiverTWCC(dtls as any, 1, 2);
    expect(rx.twccRunning).toBe(true);
    rx.twccRunning = false;
  });

  test("報告済みの番号に遅れて届いた packet は再報告しない (dumb receiver)", () => {
    // Arrange
    const { rx, dtls } = makeReceiver();

    // Act 1: 100, 102（101 missing）
    rx.handleTWCC(100);
    rx.handleTWCC(102);
    (rx as any).sendTWCC();
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(1);
    const wire1 = (
      (dtls.sendRtcp as any).mock.calls[0][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    const [fb1] = RtcpPacketConverter.deSerialize(wire1) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc1 = fb1.feedback as TransportWideCC;
    expect(
      twcc1.packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([
      [100, true],
      [101, false],
      [102, true],
    ]);
    expect(rx.nextReportTsn).toBe(103);

    // Act 2: 101 が遅れて到着（報告済み区間）、続いて 103 が到着
    rx.handleTWCC(101);
    (rx as any).sendTWCC();
    rx.handleTWCC(103);
    (rx as any).sendTWCC();

    // Assert: 報告済みの 101 は再報告せず（corrective feedback なし）、
    //         次の feedback は frontier 103 から始まる
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(2);
    const wire2 = (
      (dtls.sendRtcp as any).mock.calls[1][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    const [fb2] = RtcpPacketConverter.deSerialize(wire2) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc2 = fb2.feedback as TransportWideCC;
    expect(
      twcc2.packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([[103, true]]);
    expect(rx.nextReportTsn).toBe(104);
  });

  test("RunLength は 13bit 上限(8191)を超える run を分割する", () => {
    // Arrange: frontier=0, receive only TSN 9000 → ~9000 not-received
    const { rx, dtls } = makeReceiver();
    rx.nextReportTsn = 0;
    rx.handleTWCC(9000);
    // handleTWCC は auto-send しない（1 packet）
    (rx as any).sendTWCC();

    expect(dtls.sendRtcp).toHaveBeenCalled();
    const wire = (
      (dtls.sendRtcp as any).mock.calls[0][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    // Round-trip must succeed (13-bit field not overflowed)
    const [fb] = RtcpPacketConverter.deSerialize(wire) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc = fb.feedback as TransportWideCC;
    expect(twcc.baseSequenceNumber).toBe(0);
    expect(twcc.packetStatusCount).toBe(9001);
    // multiple run-length chunks for the not-received prefix
    const notRecvChunks = twcc.packetChunks.filter(
      (c: any) =>
        c.packetStatus === PacketStatus.TypeTCCPacketNotReceived &&
        typeof c.runLength === "number",
    );
    expect(notRecvChunks.length).toBeGreaterThan(1);
    for (const c of notRecvChunks as any[]) {
      expect(c.runLength).toBeLessThanOrEqual(8191);
    }
    // sum of not-received runs + received tail ≈ status count
    const sumNot = notRecvChunks.reduce(
      (s: number, c: any) => s + c.runLength,
      0,
    );
    expect(sumNot).toBe(9000);
  });

  test("最大長（32767 件）の報告のあとも開始番号が進み、続く packet を報告する", () => {
    // Arrange: TSN 0 を報告済み（開始番号 1）
    const { rx, dtls } = makeReceiver();
    rx.handleTWCC(0);
    (rx as any).sendTWCC();
    const reportOf = (call: number) => {
      const wire = (
        (dtls.sendRtcp as any).mock.calls[call][0] as {
          serialize: () => Buffer;
        }[]
      )[0].serialize();
      const [fb] = RtcpPacketConverter.deSerialize(wire) as [
        RtcpTransportLayerFeedback,
      ];
      return fb.feedback as TransportWideCC;
    };

    // Act 1: 32767 を受信して最大長の報告を送る
    rx.handleTWCC(32767);
    (rx as any).sendTWCC();

    // Assert: 1..32767 の 32767 件を報告し、開始番号は 32768 に進む
    expect(reportOf(1).baseSequenceNumber).toBe(1);
    expect(reportOf(1).packetStatusCount).toBe(32767);
    expect(rx.nextReportTsn).toBe(32768);

    // Act 2: 続く 32768, 32769 を受信する
    rx.handleTWCC(32768);
    rx.handleTWCC(32769);
    (rx as any).sendTWCC();

    // Assert: 破棄されず、受信として報告される
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(3);
    expect(
      reportOf(2).packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([
      [32768, true],
      [32769, true],
    ]);
  });

  test("報告窓に収まらない長い欠落のあとも、開始番号が受信 packet へ進み報告が再開する", () => {
    // Arrange: TSN 0 を報告済み（開始番号 1）
    const { rx, dtls } = makeReceiver();
    rx.handleTWCC(0);
    (rx as any).sendTWCC();

    // Act: 32767 件の欠落（1..32767）のあと 32768, 32769 を受信し、続けて 32770 も受信する
    rx.handleTWCC(32768);
    rx.handleTWCC(32769);
    (rx as any).sendTWCC();
    rx.handleTWCC(32770);
    (rx as any).sendTWCC();

    // Assert: 欠落は 1 つの報告窓（最大 32767 件）を埋めるので飛ばし、受信 packet から報告する
    const reports = (dtls.sendRtcp as any).mock.calls.map(
      ([packets]: [{ serialize: () => Buffer }[]]) => {
        const [fb] = RtcpPacketConverter.deSerialize(
          packets[0].serialize(),
        ) as [RtcpTransportLayerFeedback];
        return (fb.feedback as TransportWideCC).packetResults.map((r) => [
          r.sequenceNumber,
          r.received,
        ]);
      },
    );
    expect(reports.slice(1)).toEqual([
      [
        [32768, true],
        [32769, true],
      ],
      [[32770, true]],
    ]);
    expect(rx.nextReportTsn).toBe(32771);
  });

  test("reference_time は 64ms 量子化値で、first delta はその再構成時刻から測る", () => {
    // Arrange: inject known timestamps via extensionInfo
    const { rx, dtls } = makeReceiver();
    // 1000ms → 15 * 64ms = 960ms truncated reference
    // Use microTime-like values: 1_000_000 us = 1000ms
    const t0 = 1_000_000n; // 1000 ms
    const t1 = 1_005_000n; // 1005 ms
    rx.extensionInfo[10] = { tsn: 10, timestamp: t0 };
    rx.extensionInfo[11] = { tsn: 11, timestamp: t1 };
    (rx as any).sendTWCC();

    const wire = (
      (dtls.sendRtcp as any).mock.calls[0][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    const [fb] = RtcpPacketConverter.deSerialize(wire) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc = fb.feedback as TransportWideCC;

    // Assert: referenceTime units = floor(1000/64) = 15
    expect(twcc.referenceTime).toBe(15);
    // first delta ≈ (1000ms - 15*64ms) = 40ms = 40000us, quantized to 250us steps
    // parseDelta stores delta/250 for small delta
    expect(twcc.recvDeltas.length).toBe(2);
    // Restored receivedAtMs for first packet = 15*64 + firstDeltaMs
    const results = twcc.packetResults;
    expect(results[0].received).toBe(true);
    // 15*64 = 960ms base; first arrival ~1000ms → ~40ms delta
    expect(results[0].receivedAtMs).toBeGreaterThanOrEqual(960);
    expect(results[0].receivedAtMs).toBeLessThan(1010);
  });

  test("同一 DTLS の interleaved TSN は PacketNotReceived にしない", async () => {
    // Arrange: BUNDLE audio/video が TSN を交互に使う
    const dtls = {
      sendRtcp: vi.fn(async (_packets: unknown[]) => {}),
    };
    const audio = acquireTransportReceiverTWCC(dtls as any, 1, 100);
    const video = acquireTransportReceiverTWCC(dtls as any, 2, 200);
    audio.twccRunning = false;

    // Act: audio=100,102 / video=101 — 受信側は transport 全体を見る
    audio.handleTWCC(100);
    video.handleTWCC(101);
    audio.handleTWCC(102);
    (audio as any).sendTWCC();

    // Assert: 共有インスタンス。101 は video のパケットであり loss ではない
    expect(audio).toBe(video);
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(1);
    const packets = (dtls.sendRtcp as any).mock.calls[0][0] as {
      serialize: () => Buffer;
    }[];
    const wire = packets[0].serialize();
    const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc = rtpfb.feedback as TransportWideCC;
    expect(
      twcc.packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([
      [100, true],
      [101, true],
      [102, true],
    ]);
  });
});
