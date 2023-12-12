import { RtcpPacketConverter } from "../../../src";
import { RtcpPayloadSpecificFeedback } from "../../../src/rtcp/psfb";
import { FullIntraRequest } from "../../../src/rtcp/psfb/fullIntraRequest";

describe("fullIntraRequest", () => {
  test("valid", () => {
    const data = Buffer.from([
      // v=2, p=0, FMT=4, PSFB, len=3
      0x84, 0xce, 0x00, 0x03,
      // ssrc=0x0
      0x00, 0x00, 0x00, 0x00,
      // ssrc=0x4bc4fcb4
      0x4b, 0xc4, 0xfc, 0xb4,
      // ssrc=0x12345678
      0x12, 0x34, 0x56, 0x78,
      // Seqno=0x42
      0x42, 0x00, 0x00, 0x00,
    ]);

    const [psfb] = RtcpPacketConverter.deSerialize(data) as [
      RtcpPayloadSpecificFeedback,
    ];
    const fir = psfb.feedback as FullIntraRequest;
    expect(fir.senderSsrc).toBe(0);
    expect(fir.mediaSsrc).toBe(0x4bc4fcb4);
    expect(fir.fir).toEqual([{ ssrc: 0x12345678, sequenceNumber: 0x42 }]);
    expect(psfb.serialize()).toEqual(data);
  });
});
