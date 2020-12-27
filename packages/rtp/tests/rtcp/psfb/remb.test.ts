import { RtcpPacketConverter } from "../../../src";
import { RtcpPayloadSpecificFeedback } from "../../../src/rtcp/psfb";
import { ReceiverEstimatedMaxBitrate } from "../../../src/rtcp/psfb/remb";

describe("rtcp/psfb/remb", () => {
  test("remb", () => {
    const data = Buffer.from([
      143,
      206,
      0,
      5,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      82,
      69,
      77,
      66,
      1,
      26,
      32,
      223,
      72,
      116,
      237,
      22,
    ]);
    const [psfb] = RtcpPacketConverter.deSerialize(data) as [
      RtcpPayloadSpecificFeedback
    ];
    const remb = psfb.feedback as ReceiverEstimatedMaxBitrate;
    expect(remb.senderSsrc).toBe(1);
    expect(remb.ssrcFeedbacks).toEqual([1215622422]);
    expect(remb.bitrate).toBe(8927168n);
    expect(psfb.serialize()).toEqual(data);
  });
});
