import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  useH264,
  useOPUS,
} from "../../src";
import {
  createAudioOnlyPeerConnection,
  createOfferWithKinds,
  findMedia,
  getBundleItems,
  hostIceCandidateInit,
  parseSdp,
  replaceMLinePort,
  replaceMediaProfile,
  waitForIceCandidate,
  waitForIceGatheringComplete,
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
      sdp: replaceMLinePort(offer.sdp, "video", 0),
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

  test("remote が port 0 でも共通 codec があれば answer で再受諾しない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(["audio"]);
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const onTrack = vi.fn();
    answerer.ontrack = onTrack;
    const rejectedOffer = {
      ...offer,
      sdp: replaceMLinePort(offer.sdp, "audio", 0),
    };

    try {
      // Act: opus 対応 PC に、既に port 0 の audio offer を適用して answer を作る。
      await expect(
        answerer.setRemoteDescription(rejectedOffer),
      ).resolves.toBeUndefined();
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);
      const audioTransceiver = answerer.getTransceivers()[0];

      // Assert: 共通 codec があっても reject を維持し、pipeline / ontrack は組まない。
      expect(audioTransceiver.rejected).toBe(true);
      expect(parsedAnswer.media[0]?.port).toBe(0);
      expect(parsedAnswer.media[0]?.fmt.length).toBeGreaterThan(0);
      expect(onTrack).not.toHaveBeenCalled();
      expect(audioTransceiver.sender.codec).toBeUndefined();
      expect(audioTransceiver.receiver.tracks).toHaveLength(0);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("再交渉で非対応 codec になったら既存 pipeline を解除する", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(["audio"]);
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const unsupportedOfferer = new RTCPeerConnection({
      iceServers: [],
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/G722",
            clockRate: 8000,
            payloadType: 9,
          }),
        ],
      },
    });
    unsupportedOfferer.addTransceiver("audio", { direction: "sendonly" });

    try {
      // Act: 一度 opus で交渉したあと、同一 m-line に非対応 codec の offer を再適用する。
      await answerer.setRemoteDescription(offer);
      await answerer.setLocalDescription(await answerer.createAnswer());
      const transceiver = answerer.getTransceivers()[0];
      expect(transceiver.rejected).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();
      expect(transceiver.receiver.tracks.length).toBeGreaterThan(0);
      const existingTrack = transceiver.receiver.tracks[0];
      expect(existingTrack.readyState).toBe("live");

      const unsupportedOffer = await unsupportedOfferer.createOffer();
      await expect(
        answerer.setRemoteDescription(unsupportedOffer),
      ).resolves.toBeUndefined();
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: rejected になり、sender codec / 既存 track / RTCP は残らない。
      expect(transceiver.rejected).toBe(true);
      expect(transceiver.sender.codec).toBeUndefined();
      expect(transceiver.receiver.tracks).toHaveLength(0);
      expect(existingTrack.readyState).toBe("ended");
      expect(transceiver.receiver.rtcpRunning).toBe(false);
      expect(transceiver.receiver.receiverTWCC).toBeUndefined();
      expect(parsedAnswer.media[0]?.port).toBe(0);
      expect(parsedAnswer.media[0]?.fmt.length).toBeGreaterThan(0);
    } finally {
      await Promise.all([
        offerer.close(),
        answerer.close(),
        unsupportedOfferer.close(),
      ]);
    }
  });

  test("answer の media proto は offer の profile を引き継ぐ", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();
    const rewrittenOffer = {
      ...offer,
      sdp: replaceMediaProfile(offer.sdp, "UDP/TLS/RTP/SAVPF", "RTP/SAVPF"),
    };

    try {
      // Act: proto が RTP/SAVPF の offer を SRD し、非対応 video と対応 audio の answer を作る。
      await answerer.setRemoteDescription(rewrittenOffer);
      const parsedOffer = parseSdp(rewrittenOffer.sdp);
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: reject / 受け入れの両方で offer と同じ proto が残る。
      expect(findMedia(parsedOffer, "video")?.profile).toBe("RTP/SAVPF");
      expect(findMedia(parsedAnswer, "video")?.profile).toBe("RTP/SAVPF");
      expect(findMedia(parsedAnswer, "audio")?.profile).toBe("RTP/SAVPF");
      expect(findMedia(parsedAnswer, "video")?.port).toBe(0);
      expect(findMedia(parsedAnswer, "audio")?.port).not.toBe(0);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("inactive だが受け入れ可能な m-line は port 0 にしない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds(["audio"]);
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const inactiveOffer = {
      ...offer,
      sdp: offer.sdp?.replace("a=sendonly", "a=inactive"),
    };

    try {
      // Act: 共通 codec のある inactive audio offer を SRD し answer を作る。
      await expect(
        answerer.setRemoteDescription(inactiveOffer),
      ).resolves.toBeUndefined();
      const parsedOffer = parseSdp(inactiveOffer.sdp);
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);
      const transceiver = answerer.getTransceivers()[0];
      const offerMid = parsedOffer.media[0]?.rtp.muxId;

      // Assert: inactive は direction 交渉であり reject ではないので port 0 / BUNDLE 除外にしない。
      expect(parsedOffer.media[0]?.port).not.toBe(0);
      expect(transceiver.rejected).toBe(false);
      expect(parsedAnswer.media[0]?.direction).toBe("inactive");
      expect(parsedAnswer.media[0]?.port).not.toBe(0);
      expect(getBundleItems(parsedAnswer)).toEqual([offerMid]);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("reject 後の次回 offer は BUNDLE から port 0 を外し tag を付け替える", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();

    try {
      // Act: video を reject したあと、answerer 側で再交渉 offer を作り ICE を待つ。
      await answerer.setRemoteDescription(offer);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await waitForIceGatheringComplete(answerer);
      const candidatePromise = waitForIceCandidate(answerer);
      const nextOffer = await answerer.createOffer({ iceRestart: true });
      await answerer.setLocalDescription(nextOffer);
      const parsedOffer = parseSdp(nextOffer.sdp);
      const videoMid = findMedia(parsedOffer, "video")?.rtp.muxId;
      const audioMid = findMedia(parsedOffer, "audio")?.rtp.muxId;
      const localCandidate = await candidatePromise;

      // Assert: 次回 offer でも reject 済み video は BUNDLE に入らず、trickle は audio tag を使う。
      expect(findMedia(parsedOffer, "video")?.port).toBe(0);
      expect(findMedia(parsedOffer, "audio")?.port).not.toBe(0);
      expect(getBundleItems(parsedOffer)).toEqual([audioMid]);
      expect(getBundleItems(parsedOffer)).not.toContain(videoMid);
      expect(localCandidate.sdpMid).toBe(audioMid);
      expect(localCandidate.sdpMLineIndex).toBe(
        parsedOffer.media.findIndex((media) => media.rtp.muxId === audioMid),
      );
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("reject 済み transceiver は addTrack で再利用せず新しい m-line を足す", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [useOPUS()], video: [useH264()] },
    });
    offerer.addTransceiver("video", { direction: "sendonly" });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: 非対応 video を reject したあと、addTrack で新しい video を追加して offer する。
      await answerer.setRemoteDescription(await offerer.createOffer());
      await answerer.setLocalDescription(await answerer.createAnswer());
      const rejectedVideo = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "video");
      expect(rejectedVideo?.rejected).toBe(true);

      const sender = answerer.addTrack(new MediaStreamTrack({ kind: "video" }));
      const nextOffer = parseSdp((await answerer.createOffer()).sdp);
      const acceptedVideo = nextOffer.media.filter(
        (media) => media.kind === "video" && media.port !== 0,
      );

      // Assert: 既存 reject m-line は維持し、新しい accepted video m-line が追加される。
      expect(sender).not.toBe(rejectedVideo?.sender);
      expect(rejectedVideo?.rejected).toBe(true);
      expect(rejectedVideo?.sender.track).toBeFalsy();
      expect(answerer.getTransceivers()).toHaveLength(3);
      expect(
        nextOffer.media.filter((media) => media.kind === "video"),
      ).toHaveLength(2);
      expect(nextOffer.media[0]?.kind).toBe("video");
      expect(nextOffer.media[0]?.port).toBe(0);
      expect(acceptedVideo).toHaveLength(1);
      expect(getBundleItems(nextOffer)).not.toContain(
        nextOffer.media[0]?.rtp.muxId,
      );
      expect(getBundleItems(nextOffer)).toContain(acceptedVideo[0]?.rtp.muxId);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});
