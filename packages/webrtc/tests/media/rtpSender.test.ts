import { MediaStreamTrack } from "../../src";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport, createRtpPacket } from "../fixture";

describe("media/rtpSender", () => {
  test("stop track", () => {
    const track = new MediaStreamTrack({ kind: "audio" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track, dtls);
    sender.parameters = true as any;
    const spy = jest.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track.onRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track.onRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);

    track.stop();
    track.onRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
  });
});
