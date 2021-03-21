import { MediaStreamTrack } from "../../src";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport, createRtpPacket } from "../fixture";

describe("media/rtpSender", () => {
  test("stop track", () => {
    const track = new MediaStreamTrack({ kind: "audio", role: "read" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track, dtls);
    sender.parameters = true as any;
    const spy = jest.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);

    track.stop();
    track._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
  });

  test("replaceTrack", () => {
    const track1 = new MediaStreamTrack({ kind: "audio", role: "read" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track1, dtls);
    sender.parameters = true as any;
    const spy = jest.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track1._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    const track2 = new MediaStreamTrack({ kind: "audio", role: "read" });
    sender.replaceTrack(track2);

    track1._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track2._onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
  });
});
