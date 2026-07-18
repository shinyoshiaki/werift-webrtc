import {
  type MediaDescription,
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

    it("red fmtp references opus when red is listed after opus", async () => {
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
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
      const [media] = offer.media;
      const red = media.rtp.codecs.find((c) => c.name === "red")!;
      const opus = media.rtp.codecs.find((c) => c.name === "opus")!;
      expect(red.parameters).toBe(`${opus.payloadType}/${opus.payloadType}`);

      await caller.close();
    });

    it("red fmtp references opus with explicit payload types", async () => {
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
              payloadType: 63,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              payloadType: 111,
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      caller.addTrack(track);

      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );
      const [media] = offer.media;
      const red = media.rtp.codecs.find((c) => c.name === "red")!;
      expect(red.payloadType).toBe(63);
      expect(red.parameters).toBe("111/111");

      await caller.close();
    });

    it("does not overwrite explicitly configured red fmtp parameters", async () => {
      // Arrange: 明示 parameters は自動解決で上書きしない
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
              payloadType: 63,
              parameters: "99/99",
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              payloadType: 111,
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      // Act
      caller.addTrack(track);
      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );

      // Assert: 明示値 99/99 のまま（opus の 111/111 に差し替えない）
      const [media] = offer.media;
      const red = media.rtp.codecs.find((c) => c.name === "red")!;
      expect(red.parameters).toBe("99/99");

      await caller.close();
    });

    it("red fmtp does not reference a payload type filtered out by direction", async () => {
      // Arrange: 先頭 Opus は recvonly のみ、sendonly 側に残るのは後続 Opus
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              payloadType: 111,
              direction: "recvonly",
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
              payloadType: 63,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              payloadType: 112,
              direction: "sendonly",
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      // Act: sendonly トランシーバー向け offer を生成
      caller.addTransceiver(track, { direction: "sendonly" });
      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );

      // Assert: m= 行に無い PT 111 を参照せず、残った Opus(112) を指す
      const [media] = offer.media;
      const payloadTypes = media.fmt;
      expect(payloadTypes).toEqual([63, 112]);
      expect(payloadTypes).not.toContain(111);

      const red = media.rtp.codecs.find((c) => c.name === "red")!;
      expect(red.parameters).toBe("112/112");
      for (const pt of red.parameters!.split("/").map(Number)) {
        expect(payloadTypes).toContain(pt);
      }

      await caller.close();
    });

    it("red fmtp selects a primary with the same clock rate", async () => {
      // Arrange: 8 kHz PCMU が先頭でも、RED(48 kHz) は Opus(48 kHz) を参照する
      const caller = new RTCPeerConnection({
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/PCMU",
              clockRate: 8000,
              channels: 1,
              payloadType: 0,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/red",
              clockRate: 48000,
              channels: 2,
              payloadType: 63,
            }),
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              payloadType: 111,
            }),
          ],
        },
      });

      const track = new MediaStreamTrack({ kind: "audio" });
      // Act
      caller.addTrack(track);
      const offer = await caller.setLocalDescription(
        await caller.createOffer(),
      );

      // Assert: 異なる clock rate の PCMU(0) ではなく Opus(111) を選ぶ
      const [media] = offer.media;
      const red = media.rtp.codecs.find((c) => c.name === "red")!;
      expect(red.parameters).toBe("111/111");
      expect(red.parameters).not.toBe("0/0");

      const payloadTypes = media.fmt;
      for (const pt of red.parameters!.split("/").map(Number)) {
        expect(payloadTypes).toContain(pt);
      }

      await caller.close();
    });
  });
});
