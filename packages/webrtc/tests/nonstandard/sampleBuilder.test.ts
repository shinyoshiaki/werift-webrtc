import { random32 } from "../../../common/src";
import { OpusRtpPayload, RtpHeader, RtpPacket, SampleBuilder } from "../../src";

describe("packages/webrtc/tests/nonstandard/sampleBuilder.test.ts", () => {
  test("reset baseTimestamp", () => {
    const sampleBuilder = new SampleBuilder(OpusRtpPayload, 48000);

    let timestamp = random32();
    let sequenceNumber = 0;

    {
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Number(timestamp),
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.from([])
      );
      sampleBuilder.push(rtp);
      sampleBuilder.build();
    }
    {
      timestamp += 1600n;
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Number(timestamp),
          sequenceNumber: sequenceNumber++,
          marker: true,
        }),
        Buffer.from([])
      );
      sampleBuilder.push(rtp);
      const { relativeTimestamp } = sampleBuilder.build()!;
      expect(relativeTimestamp === 33).toBeTruthy();
    }
    sampleBuilder.resetTimestamp();
    {
      timestamp += 800n;
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Number(timestamp),
          sequenceNumber: sequenceNumber++,
        }),
        Buffer.from([])
      );
      sampleBuilder.push(rtp);
      const { relativeTimestamp } = sampleBuilder.build()!;
      expect(relativeTimestamp).toBe(0);
    }
    {
      timestamp += 800n;
      const rtp = new RtpPacket(
        new RtpHeader({
          timestamp: Number(timestamp),
          sequenceNumber: sequenceNumber++,
          marker: true,
        }),
        Buffer.from([])
      );
      sampleBuilder.push(rtp);
      const { relativeTimestamp } = sampleBuilder.build()!;
      expect(relativeTimestamp === 16).toBeTruthy();
    }
  });
});
