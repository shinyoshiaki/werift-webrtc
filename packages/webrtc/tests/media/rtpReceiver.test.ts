import { setTimeout } from "timers/promises";

import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { wrapRtx } from "../../src/media/rtpSender";
import { createDtlsTransport } from "../fixture";

describe("packages/webrtc/src/media/rtpReceiver.ts", () => {
  test("abort runRtcp", async () =>
    new Promise<void>(async (done) => {
      const dtls = createDtlsTransport();
      const receiver = new RTCRtpReceiver("audio", dtls, 1234);
      jest.spyOn(dtls, "sendRtcp");

      Promise.any([
        setTimeout(200).then(() => false),
        receiver.runRtcp().then(() => true),
      ]).then((res) => {
        expect(res).toBeTruthy();
        done();
      });

      await setTimeout(10);
      receiver.stop();
    }));

  test("handleRTP with RTX packet", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver("video", dtls, 1234);
    const track = new MediaStreamTrack({ kind: "video" });
    track.ssrc = 777;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: { apt: 96 },
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 96,
          rtx: { ssrc: 666 },
        }),
        new RTCRtpCodingParameters({
          ssrc: 666,
          payloadType: 97,
        }),
      ],
      headerExtensions: [],
    });

    setImmediate(() => {
      receiver.handleRtpBySsrc(
        wrapRtx(
          new RtpPacket(
            new RtpHeader({ ssrc: 777, payloadType: 96 }),
            Buffer.from([1, 2, 3, 4])
          ),
          97,
          0,
          666
        ),
        {}
      );
    });
    const [rtp] = await track.onReceiveRtp.asPromise();
    expect(rtp.payload).toEqual(Buffer.from([1, 2, 3, 4]));
  });
});
