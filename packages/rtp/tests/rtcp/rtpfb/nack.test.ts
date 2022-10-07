import { RtcpHeader, RtcpPacketConverter } from "../../../src";
import { RtcpTransportLayerFeedback } from "../../../src/rtcp/rtpfb";
import { GenericNack } from "../../../src/rtcp/rtpfb/nack";
import { load } from "../../utils";

describe("rtcp/rtpfb/nack", () => {
  test("test", () => {
    const data = load("rtcp_rtpfb.bin");
    const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
      RtcpTransportLayerFeedback
    ];
    const nack = rtpfb.feedback as GenericNack;
    expect(nack.lost).toEqual([
      12, 32, 39, 54, 76, 110, 123, 142, 183, 187, 223, 236, 271, 292,
    ]);
    const res = nack.serialize();
    expect(res).toEqual(data);
  });

  test("test descending pids", () => {
    const data = Buffer.from(
      Array.from(new RtcpHeader().serialize()).concat([
        0, 0, 0, 1, 17, 52, 198, 225, /* lost[0] */ 183, 30, 0, 1,
        /* lost[1] */ 9, 16, 0, 0, /* lost[2 & 3] */ 9, 36, 0, 0,
      ])
    );
    const [rtpfb] = RtcpPacketConverter.deSerialize(data) as [
      RtcpTransportLayerFeedback
    ];
    const nack = rtpfb.feedback as GenericNack;
    expect(nack.lost).toEqual([46878, 46879, 2320, 2340]);
    const res = nack.serialize();
    expect(res).toEqual(data);
  });
});
