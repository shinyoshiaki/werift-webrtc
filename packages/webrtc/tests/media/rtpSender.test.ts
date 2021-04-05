import { MediaStreamTrack, sleep } from "../../src";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport, createRtpPacket } from "../fixture";

describe("media/rtpSender", () => {
  test("stop track", () => {
    const track = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track, dtls);
    sender.parameters = true as any;
    const spy = jest.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);

    track.stop();
    expect(() => track.onReceiveRtp.execute(rtp)).toThrow();
    expect(spy).toBeCalledTimes(2);
  });

  test("replaceTrack", async () => {
    const track1 = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track1, dtls);
    sender.parameters = true as any;
    const spy = jest.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track1.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });
    sleep(0).then(() => track2.onReceiveRtp.execute(rtp));
    await sender.replaceTrack(track2);

    track1.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track2.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
  });
});
