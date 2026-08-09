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
});
