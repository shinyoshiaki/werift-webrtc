import {
  int,
  Max32Uint,
  NtpTimeBase,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../src";

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
        Buffer.alloc(0)
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
        Buffer.alloc(0)
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
        Buffer.alloc(0)
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
        Buffer.alloc(0)
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
        Buffer.alloc(0)
      );
      const [res] = time.processInput({ rtp });

      const base = res.time!;
      const toBe = (Max32Uint / time.clockRate) * 1000;
      expect(base).toBe(toBe);
    }
    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: time.clockRate / 2,
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.alloc(0)
      );
      const [res] = time.processInput({ rtp });
      const toBe = (Max32Uint / time.clockRate) * 1000 + 1000;
      expect(res.time).toBe(toBe);
    }
  });
});
