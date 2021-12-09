import {
  MediaDescription,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
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
        await caller.createOffer()
      );
      expect(offer.media.length).toBe(1);

      const checkMedia = (media: MediaDescription) => {
        expect(media.rtp.codecs.length).toBe(2);
        expect(media.rtp.codecs[0].name).toBe("red");
        expect(media.rtp.codecs[0].parameters).toBe(
          `${media.rtp.codecs[1].payloadType}/${media.rtp.codecs[1].payloadType}`
        );
        expect(media.rtp.codecs[1].name).toBe("opus");
      };
      checkMedia(offer.media[0]);

      await callee.setRemoteDescription(offer.toJSON());
      const answer = await callee.setLocalDescription(
        await callee.createAnswer()
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
        await caller.createOffer()
      );
      expect(offer.media.length).toBe(1);

      {
        const [media] = offer.media;
        expect(media.rtp.codecs.length).toBe(2);
        expect(media.rtp.codecs[0].name).toBe("red");
        expect(media.rtp.codecs[0].parameters).toBe(
          `${media.rtp.codecs[1].payloadType}/${media.rtp.codecs[1].payloadType}`
        );
        expect(media.rtp.codecs[1].name).toBe("opus");
      }

      await callee.setRemoteDescription(offer.toJSON());
      const answer = await callee.setLocalDescription(
        await callee.createAnswer()
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
});
