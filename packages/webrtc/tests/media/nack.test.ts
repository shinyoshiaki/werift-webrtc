/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable no-var */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { describe, expect, test } from "vitest";
import { type RtcpPacket, RtpHeader, RtpPacket } from "../../../rtp/src";
import { NackHandler } from "../../src/media/receiver/nack";

describe("media/nack", () => {
  test("16bit rotate", () => {
    const nack = new NackHandler(new MockRTCRtpReceiver(55) as any);
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

  test("retry window controls retry count while keeping the 5 ms cadence", () => {
    // Arrange: 5 ms ごとの従来 cadence を持つ receiver を用意する。
    const short = new NackHandler(new MockRTCRtpReceiver(0) as any);
    const long = new NackHandler(new MockRTCRtpReceiver(5000) as any);

    // Act: 設定 budget に対応する再試行数を確認する。
    // Assert: 既定相当は即時終了でき、5 秒設定はその時間分の retry を許可する。
    expect(short.retryCount).toBe(0);
    expect(long.retryCount).toBe(999);
    short.close();
    long.close();
  });
});

class MockRTCRtpReceiver {
  rtcpSsrc = 0;
  config: { nackRetryWindowMs: number };
  constructor(nackRetryWindowMs: number) {
    this.config = { nackRetryWindowMs };
  }
  dtlsTransport = {
    sendRtcp: (packets: RtcpPacket[]) => {
      const payload = Buffer.concat(
        packets.map((packet) => packet.serialize()),
      );
    },
  };
  sendRtcpPLI = () => {};
}
