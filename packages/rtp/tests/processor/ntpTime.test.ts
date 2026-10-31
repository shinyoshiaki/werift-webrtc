import { RtcpSenderInfo, RtcpSrPacket, RtpHeader, RtpPacket } from "../../src";
import { Max32Uint, NtpTimeBase } from "../../src/extra/processor";

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

  describe("SR が RTP timestamp の折り返し後、パケットが折り返し前", () => {
    const arrange = (clockRate: number, srRtpTimestamp: number) => {
      const time = new NtpTimeBase(clockRate);
      time.processInput({
        rtcp: new RtcpSrPacket({
          senderInfo: new RtcpSenderInfo({
            ntpTimestamp: 10n << 32n,
            rtpTimestamp: srRtpTimestamp,
            packetCount: 0,
            octetCount: 0,
          }),
        }),
      });
      return time;
    };
    const packet = (timestamp: number) =>
      new RtpPacket(
        new RtpHeader({ timestamp, sequenceNumber: 0 }),
        Buffer.alloc(0),
      );

    it("SR より 500ms 前のパケットは SR 時刻の 500ms 前になる", () => {
      // Arrange: 90kHz, SR は折り返し後の 44000 (= 0xfffffc18 の 500ms 後)
      const time = arrange(90000, 44000);

      // Act: 折り返し前の遅延パケットを入力する
      const [res] = time.processInput({ rtp: packet(0xfffffc18) });

      // Assert: SR 時刻 (10s) の 500ms 前 = 9500ms (約 26.5 時間後にはならない)
      expect(res.time).toBe(9500);
    });

    it("SR 後に届く折り返し後のパケットは順方向に進む", () => {
      // Arrange
      const time = arrange(90000, 44000);
      time.processInput({ rtp: packet(0xfffffc18) });

      // Act: SR より 1 秒後 (折り返し後) のパケット
      const [res] = time.processInput({ rtp: packet(44000 + 90000) });

      // Assert
      expect(res.time).toBe(11000);
    });
  });
});
