import { RtcpPacketConverter } from "../../../src";
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
});
