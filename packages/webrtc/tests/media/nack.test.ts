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
import { NackHandler } from "../../src/media/receiver/nack";

const packet = (ssrc: number, sequenceNumber: number) =>
  new RtpPacket(new RtpHeader({ sequenceNumber, ssrc }), Buffer.from(""));

describe("media/nack", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("16bit rotate", () => {
    const nack = new NackHandler(new MockRTCRtpReceiver() as any);
    nack.addPacket(packet(1, 65535));
    nack.addPacket(packet(1, 3));

    expect(nack.lostSeqNumbers).toEqual([0, 1, 2]);
    nack.close();
  });

  test("複数 SSRC を交互に受けても SSRC 間の seq を比較しない", () => {
    // Arrange
    const nack = new NackHandler(new MockRTCRtpReceiver() as any);

    // Act: 離れた seq 空間の 2 SSRC を欠落なく交互に投入する。
    for (let i = 0; i < 5; i++) {
      nack.addPacket(packet(1, 100 + i));
      nack.addPacket(packet(2, 40000 + i));
    }

    // Assert: どちらの SSRC にもロスはない。
    expect(nack.ssrcs.sort()).toEqual([1, 2]);
    expect(nack.lostSeqNumbersOf(1)).toEqual([]);
    expect(nack.lostSeqNumbersOf(2)).toEqual([]);
    nack.close();
  });

  test("NACK は欠落した SSRC 宛てに送られ、復元で解消される", async () => {
    // Arrange
    vi.useFakeTimers();
    const receiver = new MockRTCRtpReceiver();
    const nack = new NackHandler(receiver as any);
    const notified: GenericNack[] = [];
    nack.onPacketLost.subscribe((n) => notified.push(n));

    // Act: SSRC 1 は欠落なし、SSRC 2 は seq 11, 12 を失う。
    nack.addPacket(packet(1, 100));
    nack.addPacket(packet(2, 10));
    nack.addPacket(packet(1, 101));
    nack.addPacket(packet(2, 13));
    nack.addPacket(packet(1, 102));
    await vi.advanceTimersByTimeAsync(5);

    // Assert: 送信と通知はどちらも SSRC 2 宛てで、失った seq だけを含む。
    expect(receiver.nacks.length).toBeGreaterThan(0);
    expect(notified.length).toBe(receiver.nacks.length);
    for (const sent of [...receiver.nacks, ...notified]) {
      expect(sent.mediaSourceSsrc).toBe(2);
      expect(sent.lost).toEqual([11, 12]);
    }

    // Act: SSRC 2 の欠落を (RTX から復元したパケットとして) 受ける。
    nack.addPacket(packet(2, 11));
    nack.addPacket(packet(2, 12));
    const count = receiver.nacks.length;
    await vi.advanceTimersByTimeAsync(50);

    // Assert: ロスは解消し、送信 timer も止まる。
    expect(nack.lostSeqNumbersOf(2)).toEqual([]);
    expect(receiver.nacks.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
    nack.close();
  });

  test("close() はすべての SSRC の timer を止める", () => {
    // Arrange
    vi.useFakeTimers();
    const nack = new NackHandler(new MockRTCRtpReceiver() as any);
    for (const ssrc of [1, 2]) {
      nack.addPacket(packet(ssrc, 1));
      nack.addPacket(packet(ssrc, 5));
    }
    expect(vi.getTimerCount()).toBe(2);

    // Act
    nack.close();

    // Assert: timer と SSRC ごとの状態がすべて解放され、以降の投入も無視される。
    expect(vi.getTimerCount()).toBe(0);
    expect(nack.ssrcs).toEqual([]);
    nack.addPacket(packet(1, 10));
    nack.addPacket(packet(1, 20));
    expect(vi.getTimerCount()).toBe(0);
  });
});

class MockRTCRtpReceiver {
  rtcpSsrc = 0;
  readonly nacks: GenericNack[] = [];
  dtlsTransport = {
    sendRtcp: async (packets: RtcpPacket[]) => {
      for (const p of packets) {
        if (
          p instanceof RtcpTransportLayerFeedback &&
          p.feedback instanceof GenericNack
        ) {
          this.nacks.push(p.feedback);
        }
      }
    },
  };
  sendRtcpPLI = () => {};
}
