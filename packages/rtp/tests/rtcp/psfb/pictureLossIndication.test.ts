import { RtcpPacketConverter } from "../../../src";
import { RtcpPayloadSpecificFeedback } from "../../../src/rtcp/psfb";
import { PictureLossIndication } from "../../../src/rtcp/psfb/pictureLossIndication";

describe("fullIntraRequest", () => {
  test("valid", () => {
    const data = Buffer.from([
      // v=2, p=0, FMT=1, PSFB, len=1
      0x81, 0xce, 0x00, 0x02,
      // ssrc=0x0
      0x00, 0x00, 0x00, 0x00,
      // ssrc=0x4bc4fcb4
      0x4b, 0xc4, 0xfc, 0xb4,
    ]);

    const [psfb] = RtcpPacketConverter.deSerialize(data) as [
      RtcpPayloadSpecificFeedback
    ];
    const pli = psfb.feedback as PictureLossIndication;
    expect(pli.count).toBe(PictureLossIndication.count);
    expect(pli.senderSsrc).toBe(0);
    expect(pli.mediaSsrc).toBe(0x4bc4fcb4);
    expect(psfb.serialize()).toEqual(data);
  });
});
