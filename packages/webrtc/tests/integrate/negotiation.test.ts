import {
  type MediaDescription,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useAV1,
  useAV1X,
} from "../../src";

describe("codec negotiation", () => {
  describe("red negotiation", () => {
    it("caller offer red/callee answer red", async () => {
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            }),
          ],
        },
      });
      const callee = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      caller.addTrack(track);

      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );
      expect(offer.media.length).toBe(1);

      const checkMedia = (media: MediaDescription) => {
        expect(media.rtp.codecs.length).toBe(2);
        expect(media.rtp.codecs[0].name).toBe("red");
        expect(media.rtp.codecs[0].parameters).toBe(
          `${media.rtp.codecs[1].payloadType}/${media.rtp.codecs[1].payloadType}`,
        );
        expect(media.rtp.codecs[1].name).toBe("opus");
      };
      checkMedia(offer.media[0]);

      await callee.setRemoteDescription(offer.toJSON());
      const answer = await callee.setLocalDescription(
        await callee.createAnswer(),
      );
      checkMedia(answer.media[0]);
      await caller.setRemoteDescription(answer.toJSON());

      const [sender] = caller.getSenders();
      expect(sender.codec?.mimeType.includes("red")).toBeTruthy();

      await Promise.all([caller.close(), callee.close()]);
    });

    it("caller offer red/callee not answer red", async () => {
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            }),
          ],
        },
      });
      const callee = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      caller.addTrack(track);

      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );
      expect(offer.media.length).toBe(1);

      {
        const [media] = offer.media;
        expect(media.rtp.codecs.length).toBe(2);
        expect(media.rtp.codecs[0].name).toBe("red");
        expect(media.rtp.codecs[0].parameters).toBe(
          `${media.rtp.codecs[1].payloadType}/${media.rtp.codecs[1].payloadType}`,
        );
        expect(media.rtp.codecs[1].name).toBe("opus");
      }

      await callee.setRemoteDescription(offer.toJSON());
      const answer = await callee.setLocalDescription(
        await callee.createAnswer(),
      );
      {
        const [media] = answer.media;
        expect(media.rtp.codecs.length).toBe(1);
        expect(media.rtp.codecs[0].name).toBe("opus");
      }

      await caller.setRemoteDescription(answer.toJSON());

      const [sender] = caller.getSenders();
      expect(sender.codec?.mimeType.includes("opus")).toBeTruthy();

      await Promise.all([caller.close(), callee.close()]);
    });
  });

  describe("AV1 / AV1X legacy name negotiation", () => {
    const negotiate = async (
      callerCodec: RTCRtpCodecParameters,
      calleeCodec: RTCRtpCodecParameters,
    ) => {
      // Arrange
      const caller = new RTCPeerConnection({
        codecs: { audio: [], video: [callerCodec] },
      });
      const callee = new RTCPeerConnection({
        codecs: { audio: [], video: [calleeCodec] },
      });
      caller.addTrack(new MediaStreamTrack({ kind: "video" }));
      // Act
      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );
      await callee.setRemoteDescription(offer);
      const answer = await callee.setLocalDescription(
        await callee.createAnswer(),
      );
      await Promise.all([caller.close(), callee.close()]);
      return answer;
    };

    it.each([
      ["AV1 offer / AV1X answerer", useAV1(), useAV1X()],
      ["AV1X offer / AV1 answerer", useAV1X(), useAV1()],
    ])(
      "%s accepts the video m-line",
      async (_name, callerCodec, calleeCodec) => {
        const answer = await negotiate(callerCodec, calleeCodec);
        // Assert: m=video が拒否 (port 0) されず、codec が 1 つ選ばれる
        expect(answer.media[0].port).not.toBe(0);
        expect(answer.media[0].rtp.codecs.length).toBe(1);
        expect(answer.media[0].rtp.codecs[0].name.toLowerCase()).toMatch(
          /^av1/,
        );
      },
    );
  });
});
