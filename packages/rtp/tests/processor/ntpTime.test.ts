import {
  ntpTime2Sec,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { Max32Uint, NtpTimeBase } from "../../src/extra/processor";
import {
  createNtpTimestamp,
  createRtpAt,
  createSenderReport,
} from "../utils";

describe("ntpTime", () => {
  it("rollover", () => {
    const time = new NtpTimeBase(90000);
    let sequenceNumber = 0;

    time.processInput({
      rtcp: new RtcpSrPacket({
        senderInfo: new RtcpSenderInfo({
          ntpTimestamp: 0n,
          rtpTimestamp: Max32Uint - time.clockRate / 2,
          packetCount: 0,
          octetCount: 0,
        }),
      }),
    });

    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Max32Uint - time.clockRate / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      const [res] = time.processInput({ rtp });
      expect(res.time).toBe(0);
    }
    {
      // rollover
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: time.clockRate / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      const [res] = time.processInput({ rtp });
      expect(res.time).toBe(1000);
    }
    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: time.clockRate / 2 + time.clockRate,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      const [res] = time.processInput({ rtp });
      expect(res.time).toBe(2000);
    }
    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Max32Uint / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      time.processInput({ rtp });
    }

    {
      // 一周してきた
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Max32Uint - time.clockRate / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      const [res] = time.processInput({ rtp });

      const base = res.time!;
      const toBe = Math.round((Max32Uint / time.clockRate) * 1000);
      expect(base).toBe(toBe);
    }
    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: time.clockRate / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0),
      );
      const [res] = time.processInput({ rtp });
      const toBe = Math.round((Max32Uint / time.clockRate) * 1000 + 1000);
      expect(res.time).toBe(toBe);
    }
  });

  it("ntpTime2Sec treats the low 32 bits as a binary fraction", () => {
    // Arrange
    const half = createNtpTimestamp(1000, 0x80000000);
    const quarter = createNtpTimestamp(1000, 0x40000000);
    const almostOne = createNtpTimestamp(1000, 0xffffffff);

    // Act: 小数部 2^31 / 2^30 / 2^32-1 の NTP を秒へ変換する
    const results = [half, quarter, almostOne].map(ntpTime2Sec);

    // Assert: 小数部は 10 進の桁ではなく 2^32 分の 1 秒単位で換算される
    expect(results[0]).toBe(1000.5);
    expect(results[1]).toBe(1000.25);
    expect(results[2]).toBeGreaterThan(1000.9999999);
    expect(results[2]).toBeLessThan(1001);
  });

  it("aligns audio and video to the same wall clock via SR fractions", () => {
    // Arrange: 同じ瞬間 (1000.5s) を指す SR を音声/映像で別々の RTP 基準値で受け取る
    const srNtp = createNtpTimestamp(1000, 0x80000000);
    const audio = new NtpTimeBase(48000);
    const video = new NtpTimeBase(90000);
    audio.processInput({ rtcp: createSenderReport(srNtp, 480_000) });
    video.processInput({ rtcp: createSenderReport(srNtp, 900_000) });

    // Act: SR から 100ms 後の RTP を両トラックに入力する
    const [audioOut] = audio.processInput({
      rtp: createRtpAt(480_000 + 4_800),
    });
    const [videoOut] = video.processInput({
      rtp: createRtpAt(900_000 + 9_000),
    });

    // Assert: どちらも SR の NTP (1000.5s) + 100ms になり、トラック間でずれない
    expect(audioOut.time).toBe(1_000_600);
    expect(videoOut.time).toBe(1_000_600);
  });
});
