import { describe, expect, test, vi } from "vitest";
import {
  PacketStatus,
  RtcpPacketConverter,
  type RtcpTransportLayerFeedback,
  type TransportWideCC,
} from "../../src";
import { ReceiverTWCC } from "../../src/media/receiver/receiverTwcc";

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

  test("gap を PacketNotReceived として encode し round-trip で復元する", async () => {
    // Arrange
    const { rx, dtls } = makeReceiver();
    // Act: TSN 100, 102 received (101 missing)
    rx.handleTWCC(100);
    rx.handleTWCC(102);
    // Force send (buffer < 10)
    (rx as any).sendTWCC();

    // Assert: one RTCP sent
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(1);
    const packets = (dtls.sendRtcp as any).mock.calls[0][0] as {
      serialize: () => Buffer;
    }[];
    const wire = packets[0].serialize();
    const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc = rtpfb.feedback as TransportWideCC;
    const results = twcc.packetResults;

    expect(twcc.baseSequenceNumber).toBe(100);
    expect(twcc.packetStatusCount).toBe(3);
    expect(results.length).toBe(3);
    expect(results.map((r) => [r.sequenceNumber, r.received])).toEqual([
      [100, true],
      [101, false],
      [102, true],
    ]);
    // received status ごとに delta が必要 — deserialize が完走していること
    expect(twcc.recvDeltas.length).toBe(2);
    // chunks に not-received が含まれる
    expect(
      twcc.packetChunks.some(
        (c: any) =>
          c.packetStatus === PacketStatus.TypeTCCPacketNotReceived ||
          c.symbolList?.includes(PacketStatus.TypeTCCPacketNotReceived),
      ),
    ).toBe(true);
  });

  test("16-bit wrap では base=65534, count=4", async () => {
    // Arrange
    const { rx, dtls } = makeReceiver();
    // Act
    rx.handleTWCC(65534);
    rx.handleTWCC(65535);
    rx.handleTWCC(0);
    rx.handleTWCC(1);
    (rx as any).sendTWCC();

    // Assert
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(1);
    const packets = (dtls.sendRtcp as any).mock.calls[0][0] as {
      serialize: () => Buffer;
    }[];
    const wire = packets[0].serialize();
    const [rtpfb] = RtcpPacketConverter.deSerialize(wire) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc = rtpfb.feedback as TransportWideCC;
    expect(twcc.baseSequenceNumber).toBe(65534);
    expect(twcc.packetStatusCount).toBe(4);
    expect(twcc.packetResults.map((r) => r.sequenceNumber)).toEqual([
      65534, 65535, 0, 1,
    ]);
    expect(twcc.packetResults.every((r) => r.received)).toBe(true);
  });

  test("constructor で twccRunning=true（100ms 周期が起動する）", () => {
    const dtls = { sendRtcp: vi.fn(async () => {}) };
    const rx = new ReceiverTWCC(dtls as any, 1, 2);
    expect(rx.twccRunning).toBe(true);
    rx.twccRunning = false;
  });

  test("feedback 境界をまたぐ loss を次 feedback で PacketNotReceived として報告する", () => {
    // Arrange
    const { rx, dtls } = makeReceiver();

    // Act 1: TSN 100 only
    rx.handleTWCC(100);
    (rx as any).sendTWCC();
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(1);
    const wire1 = (
      (dtls.sendRtcp as any).mock.calls[0][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    const [fb1] = RtcpPacketConverter.deSerialize(wire1) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc1 = fb1.feedback as TransportWideCC;
    expect(twcc1.baseSequenceNumber).toBe(100);
    expect(twcc1.packetStatusCount).toBe(1);
    expect(
      twcc1.packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([[100, true]]);
    expect(rx.nextReportTsn).toBe(101);

    // Act 2: TSN 101 lost, TSN 102 received
    rx.handleTWCC(102);
    (rx as any).sendTWCC();
    expect(dtls.sendRtcp).toHaveBeenCalledTimes(2);
    const wire2 = (
      (dtls.sendRtcp as any).mock.calls[1][0] as { serialize: () => Buffer }[]
    )[0].serialize();
    const [fb2] = RtcpPacketConverter.deSerialize(wire2) as [
      RtcpTransportLayerFeedback,
    ];
    const twcc2 = fb2.feedback as TransportWideCC;

    // Assert: base=101, [101 lost, 102 received]
    expect(twcc2.baseSequenceNumber).toBe(101);
    expect(twcc2.packetStatusCount).toBe(2);
    expect(
      twcc2.packetResults.map((r) => [r.sequenceNumber, r.received]),
    ).toEqual([
      [101, false],
      [102, true],
    ]);
    expect(twcc2.recvDeltas.length).toBe(1);
    expect(rx.nextReportTsn).toBe(103);
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
});
