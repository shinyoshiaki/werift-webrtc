import { ntpTime } from "../../src";
import {
  Max32bit,
  MediaBuffer,
  ntpTime2Time,
} from "../../src/nonstandard/lipsync";

describe("packages/webrtc/tests/nonstandard/lipsync.test.ts", () => {
  describe("mediaBuffer calcNtpTime", () => {
    test("calc after base rtpTimestamp", () => {
      const mediaBuffer = new MediaBuffer(1);

      mediaBuffer.baseNtpTimestamp = ntpTime();
      mediaBuffer.baseRtpTimestamp = 5;

      const ntp = mediaBuffer.calcNtpTime(7);

      expect(ntp).toBe(ntpTime2Time(mediaBuffer.baseNtpTimestamp) + 7 - 5);
    });

    test("calc before base rtpTimestamp", () => {
      const mediaBuffer = new MediaBuffer(1);

      mediaBuffer.baseNtpTimestamp = ntpTime();
      mediaBuffer.baseRtpTimestamp = 5;

      const ntp = mediaBuffer.calcNtpTime(2);

      expect(ntp).toBe(ntpTime2Time(mediaBuffer.baseNtpTimestamp) + 2 - 5);
    });

    test("target rtpTimestamp is rollover", () => {
      const mediaBuffer = new MediaBuffer(1);

      mediaBuffer.baseNtpTimestamp = ntpTime();
      mediaBuffer.baseRtpTimestamp = Max32bit - 5;

      const ntp = mediaBuffer.calcNtpTime(1);

      expect(ntp).toBe(ntpTime2Time(mediaBuffer.baseNtpTimestamp) + 5 + 1);
    });

    test("base rtpTimestamp is rollover", () => {
      const mediaBuffer = new MediaBuffer(1);

      mediaBuffer.baseNtpTimestamp = ntpTime();
      mediaBuffer.baseRtpTimestamp = 5;

      const ntp = mediaBuffer.calcNtpTime(Max32bit - 4);

      expect(ntp).toBe(ntpTime2Time(mediaBuffer.baseNtpTimestamp) - 4 - 5);
    });
  });
});
