import { RTCPeerConnection } from "../../src";
import {
  createAudioOnlyPeerConnection,
  createOfferWithKinds,
  findMedia,
  getBundleItems,
  hostIceCandidateInit,
  parseSdp,
  waitForIceCandidate,
} from "./705.helpers";

describe("https://github.com/shinyoshiaki/werift-webrtc/issues/705", () => {
  test("unbundled: 非対応 video を reject し対応 audio を受け入れる", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(
      ["video", "audio"],
      { bundlePolicy: "disable" },
    );
    const answerer = createAudioOnlyPeerConnection({
      bundlePolicy: "disable",
    });
    const onTrack = vi.fn();
    answerer.ontrack = onTrack;

    try {
      // Act: 非対応 video + 対応 audio の unbundled offer を SRD し answer を作る。
      await expect(
        answerer.setRemoteDescription(offer),
      ).resolves.toBeUndefined();
      expect(answerer.signalingState).toBe("have-remote-offer");
      const answer = await answerer.createAnswer();
      const parsedOffer = parseSdp(offer.sdp);
      const parsedAnswer = parseSdp(answer.sdp);
      const offerVideo = findMedia(parsedOffer, "video");
      const offerAudio = findMedia(parsedOffer, "audio");
      const answerVideo = findMedia(parsedAnswer, "video");
      const answerAudio = findMedia(parsedAnswer, "audio");
      const videoTransceiver = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "video");
      const audioTransceiver = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "audio");

      // Assert: video だけ port 0 で reject され、audio は受け入れ、MID / 順序は維持される。
      expect(parsedAnswer.media.map((media) => media.kind)).toEqual([
        "video",
        "audio",
      ]);
      expect(answerVideo?.port).toBe(0);
      expect(answerVideo?.fmt.length).toBeGreaterThan(0);
      expect(answerVideo?.rtp.muxId).toBe(offerVideo?.rtp.muxId);
      expect(answerAudio?.port).not.toBe(0);
      expect(answerAudio?.rtp.muxId).toBe(offerAudio?.rtp.muxId);
      expect(getBundleItems(parsedAnswer)).toBeUndefined();
      expect(videoTransceiver?.rejected).toBe(true);
      expect(videoTransceiver?.sender.codec).toBeUndefined();
      expect(videoTransceiver?.receiver.tracks).toHaveLength(0);
      expect(audioTransceiver?.rejected).toBe(false);
      expect(onTrack.mock.calls.map(([event]) => event.track.kind)).toEqual([
        "audio",
      ]);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("BUNDLE の非 tag m-line が非対応なら group から外す", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "audio",
      "video",
    ]);
    const answerer = createAudioOnlyPeerConnection();

    try {
      // Act: tagged audio + 非対応 video の BUNDLE offer を SRD し answer を作る。
      await expect(
        answerer.setRemoteDescription(offer),
      ).resolves.toBeUndefined();
      const parsedOffer = parseSdp(offer.sdp);
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);
      const offerAudioMid = findMedia(parsedOffer, "audio")?.rtp.muxId;
      const offerVideoMid = findMedia(parsedOffer, "video")?.rtp.muxId;
      const answerVideo = findMedia(parsedAnswer, "video");
      const answerAudio = findMedia(parsedAnswer, "audio");

      // Assert: offerer-tagged は残り、非対応の非 tag video は port 0 かつ BUNDLE から除外される。
      expect(getBundleItems(parsedOffer)?.[0]).toBe(offerAudioMid);
      expect(answerVideo?.port).toBe(0);
      expect(answerVideo?.fmt.length).toBeGreaterThan(0);
      expect(answerAudio?.port).not.toBe(0);
      expect(getBundleItems(parsedAnswer)).toEqual([offerAudioMid]);
      expect(getBundleItems(parsedAnswer)).not.toContain(offerVideoMid);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("BUNDLE の offerer-tagged が非対応なら tag を再選択する", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();

    try {
      // Act: tagged video が非対応の BUNDLE offer を SRD し、answer 適用後の local candidate を待つ。
      await expect(
        answerer.setRemoteDescription(offer),
      ).resolves.toBeUndefined();
      const parsedOffer = parseSdp(offer.sdp);
      const offerVideoMid = findMedia(parsedOffer, "video")?.rtp.muxId;
      const offerAudioMid = findMedia(parsedOffer, "audio")?.rtp.muxId;
      const answer = await answerer.createAnswer();
      const candidatePromise = waitForIceCandidate(answerer);
      await answerer.setLocalDescription(answer);
      const parsedAnswer = parseSdp(answer.sdp);
      const localCandidate = await candidatePromise;

      // Assert: 受け入れた audio が新しい tag になり、local trickle もその MID / index を使う。
      expect(getBundleItems(parsedOffer)?.[0]).toBe(offerVideoMid);
      expect(findMedia(parsedAnswer, "video")?.port).toBe(0);
      expect(findMedia(parsedAnswer, "audio")?.port).not.toBe(0);
      expect(getBundleItems(parsedAnswer)).toEqual([offerAudioMid]);
      expect(getBundleItems(parsedAnswer)?.[0]).toBe(offerAudioMid);
      expect(localCandidate.sdpMid).toBe(offerAudioMid);
      expect(localCandidate.sdpMLineIndex).toBe(
        parsedAnswer.media.findIndex(
          (media) => media.rtp.muxId === offerAudioMid,
        ),
      );
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("remote が port 0 かつローカル codec が無い場合も SRD は成功し pipeline を組まない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(["video"]);
    const answerer = createAudioOnlyPeerConnection();
    const onTrack = vi.fn();
    answerer.ontrack = onTrack;
    const rejectedOffer = {
      ...offer,
      sdp: offer.sdp?.replace(/m=video \d+/, "m=video 0"),
    };

    try {
      // Act: 既に port 0 の video offer を、video codec を持たない PC に適用する。
      await expect(
        answerer.setRemoteDescription(rejectedOffer),
      ).resolves.toBeUndefined();
      const answer = await answerer.createAnswer();
      const parsedAnswer = parseSdp(answer.sdp);
      const videoTransceiver = answerer.getTransceivers()[0];

      // Assert: 例外は出ず、track / sender / receiver pipeline は組まれない。
      expect(onTrack).not.toHaveBeenCalled();
      expect(videoTransceiver.rejected).toBe(true);
      expect(videoTransceiver.sender.codec).toBeUndefined();
      expect(videoTransceiver.receiver.tracks).toHaveLength(0);
      expect(videoTransceiver.receiver.receiverTWCC).toBeUndefined();
      expect(parsedAnswer.media[0]?.port).toBe(0);
      expect(parsedAnswer.media[0]?.fmt.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("reject した m-line の MID / sdpMLineIndex でも addIceCandidate できる", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();
    const parsedOffer = parseSdp(offer.sdp);
    const videoMid = findMedia(parsedOffer, "video")?.rtp.muxId;
    const audioMid = findMedia(parsedOffer, "audio")?.rtp.muxId;
    const videoIndex = parsedOffer.media.findIndex(
      (media) => media.kind === "video",
    );
    const audioIndex = parsedOffer.media.findIndex(
      (media) => media.kind === "audio",
    );

    try {
      // Act: 非対応 video を含む offer を SRD したあと、両 m-line の candidate を追加する。
      await answerer.setRemoteDescription(offer);
      expect(videoMid).toBeDefined();
      expect(audioMid).toBeDefined();

      // Assert: reject 予定の video MID / index でも remote media が残り解決できる。
      await expect(
        answerer.addIceCandidate(hostIceCandidateInit(videoMid!, videoIndex)),
      ).resolves.toBeUndefined();
      await expect(
        answerer.addIceCandidate(hostIceCandidateInit(audioMid!, audioIndex)),
      ).resolves.toBeUndefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("BUNDLE の m-section を全部 reject したときは group を省略する", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(["video"]);
    const answerer = createAudioOnlyPeerConnection();

    try {
      // Act: 対応 codec が無い BUNDLE video offer を SRD し answer を作る。
      await expect(
        answerer.setRemoteDescription(offer),
      ).resolves.toBeUndefined();
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: 受け入れ m-line が無いので a=group:BUNDLE は出さない。
      expect(parsedAnswer.media[0]?.port).toBe(0);
      expect(getBundleItems(parsedAnswer)).toBeUndefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});
