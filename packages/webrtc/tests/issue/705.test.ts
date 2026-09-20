import {
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
  useOPUS,
} from "../../src";
import {
  createAudioOnlyPeerConnection,
  createBundledPeerConnection,
  createOfferWithKinds,
  findMedia,
  getBundleItems,
  hostIceCandidateInit,
  negotiateOfferAnswer,
  parseSdp,
  replaceMLinePort,
  replaceMediaDirection,
  replaceMediaMid,
  replaceMediaPortByMid,
  replaceMediaProfile,
  rewriteBundleGroup,
  sendTestRtp,
  waitForConnection,
  waitForIceCandidate,
  waitForIceGatheringComplete,
  waitForRtp,
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

  test("再交渉で非対応 codec になっても answer 確定までは既存 pipeline を維持する", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: 同一 ufrag のまま再 offer できるよう、初回 offer の SDP を保持して交渉・接続する。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      sendTestRtp(track, "before");
      await expect(
        waitForRtp(answerer.getTransceivers()[0]),
      ).resolves.toBeDefined();

      // Act: 同一 m-line を非対応 codec にした再 offer を適用する。
      // PCMU が残ると共通 codec 扱いになるため、両方とも非対応に書き換える。
      const unsupportedSdp = firstOffer.sdp
        ?.replace(/opus\/48000\/2/i, "G722/8000")
        .replace(/PCMU\/8000/i, "PCMA/8000");
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: unsupportedSdp }),
      ).resolves.toBeUndefined();
      const transceiver = answerer.getTransceivers()[0];
      const existingTrack = transceiver.receiver.tracks[0];

      // Assert: pending rejection では current pipeline が残り、旧 RTP も受信できる。
      expect(transceiver.rejected).toBe(true);
      expect(transceiver.stopped).toBe(false);
      expect(transceiver.stopping).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();
      expect(transceiver.receiver.tracks.length).toBeGreaterThan(0);
      expect(existingTrack.readyState).toBe("live");
      sendTestRtp(track, "during");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
      expect(parseSdp((await answerer.createAnswer()).sdp).media[0]?.port).toBe(
        0,
      );

      // Act: port 0 の answer を適用して reject を確定させる。
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Assert: 確定後に初めて pipeline が解除され、terminal stopped になる。
      expect(transceiver.sender.codec).toBeUndefined();
      expect(transceiver.receiver.tracks).toHaveLength(0);
      expect(existingTrack.readyState).toBe("ended");
      expect(transceiver.receiver.rtcpRunning).toBe(false);
      expect(transceiver.receiver.receiverTWCC).toBeUndefined();
      expect(transceiver.stopped).toBe(true);
      expect(transceiver.currentDirection).toBe("stopped");
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
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

  test("inactive な m-line は codec reject と別状態として扱う", async () => {
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
      const transceiver = answerer.getTransceivers()[0];
      const parsedAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: inactive は direction 交渉であり codec reject フラグは立てず pipeline も拒否しない。
      expect(transceiver.rejected).toBe(false);
      expect(transceiver.offerDirection).toBe("inactive");
      expect(transceiver.sender.codec).toBeDefined();
      expect(transceiver.receiver.tracks.length).toBeGreaterThan(0);
      // Assert: inactive は direction 交渉なので port 0 / BUNDLE 除外にしない。
      expect(parsedAnswer.media[0]?.direction).toBe("inactive");
      expect(parsedAnswer.media[0]?.port).not.toBe(0);
      expect(getBundleItems(parsedAnswer)).toContain(
        parsedAnswer.media[0]?.rtp.muxId,
      );
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("inactive な m-line が offer に残っていても新規 m-line 用に transceiver を奪わない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "video",
    ]);
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Arrange: sendonly の 2 m-line を交渉したあと、mid=1 を inactive にした offer を適用する。
      await answerer.setRemoteDescription(offer);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await answerer.setRemoteDescription({
        ...offer,
        sdp: replaceMediaDirection(offer.sdp, "1", "inactive"),
      });
      await answerer.setLocalDescription(await answerer.createAnswer());
      const inactiveTransceiver = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mid === "1");
      expect(inactiveTransceiver?.currentDirection).toBe("inactive");

      // Act: mid=1 を inactive のまま残し、新しい mid=2 を追加した offer を適用する。
      const { pc: threeOfferer, offer: threeOffer } =
        await createOfferWithKinds(["video", "video", "video"]);
      await expect(
        answerer.setRemoteDescription({
          ...threeOffer,
          sdp: replaceMediaDirection(threeOffer.sdp, "1", "inactive"),
        }),
      ).resolves.toBeUndefined();
      const answer = await answerer.createAnswer();
      await threeOfferer.close();

      // Assert: mid=1 の transceiver は置換されず、新規 mid=2 用が別に足されて answer が成立する。
      expect(answerer.getTransceivers().find((t) => t.mid === "1")).toBe(
        inactiveTransceiver,
      );
      expect(
        answerer.getTransceivers().find((t) => t.mid === "2"),
      ).toBeDefined();
      expect(parseSdp(answer.sdp).media).toHaveLength(3);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("removeTrack 後の再交渉でも既存 mid の answer を組み立てられる", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "video" });

    try {
      // Arrange: sendonly video を 3 本交渉し、2 本目だけ removeTrack する。
      offerer.addTransceiver(track, { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);

      const second = offerer.addTransceiver(track, { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);

      offerer.addTransceiver(track, { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);

      offerer.removeTrack(second.sender);
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const removeAnswer = parseSdp((await answerer.createAnswer()).sdp);
      const removed = removeAnswer.media[1];

      // Assert: removeTrack の inactive は reject せず、BUNDLE にも残る。
      expect(removed?.direction).toBe("inactive");
      expect(removed?.port).not.toBe(0);
      expect(getBundleItems(removeAnswer)).toContain(removed?.rtp.muxId);
      expect(
        answerer.getTransceivers().find((t) => t.mid === "1")?.rejected,
      ).toBe(false);

      // Act: 2 本目を差し替える新規 transceiver を足して再交渉する。
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      offerer.addTransceiver(track, { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).resolves.toBeUndefined();
      const replaceAnswer = await answerer.createAnswer();

      // Assert: 既存 mid=1 を失わず answer を生成できる。
      expect(
        parseSdp(replaceAnswer.sdp).media.map((media) => media.rtp.muxId),
      ).toEqual(
        parseSdp(offerer.localDescription?.sdp).media.map(
          (media) => media.rtp.muxId,
        ),
      );
      expect(
        answerer
          .getTransceivers()
          .find((transceiver) => transceiver.mid === "1"),
      ).toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("recycle で mid が付け替わっても元の mid が offer に残れば answer できる", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "video",
      "video",
    ]);
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Arrange: 3 m-line を交渉したあと mid=1 を inactive にする。
      await answerer.setRemoteDescription(offer);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await answerer.setRemoteDescription({
        ...offer,
        sdp: replaceMediaDirection(offer.sdp, "1", "inactive"),
      });
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Act: Chrome の recycle を模し、旧 mid=1 を port 0 で残しつつ
      // 同じ位置に mid=3 の新規 section を挿入した offer を適用する。
      const sections = offer.sdp?.split(/\r\n(?=m=)/) ?? [];
      const placeholder = replaceMediaPortByMid(
        replaceMediaDirection(sections[2], "1", "inactive"),
        "1",
        0,
      );
      const recycledSection = replaceMediaMid(sections[2], "1", "3");
      const recycledSdp = rewriteBundleGroup(
        [
          sections[0],
          sections[1],
          placeholder,
          recycledSection,
          sections[3],
        ].join("\r\n"),
        ["0", "1", "3", "2"],
      );
      const recycledOffer = { type: "offer" as const, sdp: recycledSdp };
      await expect(
        answerer.setRemoteDescription(recycledOffer),
      ).resolves.toBeUndefined();
      const answer = await answerer.createAnswer();

      // Assert: mid=1 の transceiver は残し、新しい mid=3 用も足して answer する。
      expect(
        answerer.getTransceivers().map((transceiver) => transceiver.mid),
      ).toEqual(expect.arrayContaining(["0", "1", "2", "3"]));
      expect(
        parseSdp(answer.sdp).media.map((media) => media.rtp.muxId),
      ).toEqual(
        parseSdp(recycledOffer.sdp).media.map((media) => media.rtp.muxId),
      );
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

  test("reject 確定後の新規 transceiver は同じ m-line を新 MID で再利用する", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [useOPUS()], video: [useH264()] },
    });
    offerer.addTransceiver("video", { direction: "sendonly" });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: 非対応 video を reject して answer を確定させたあと、新しい video を追加する。
      await answerer.setRemoteDescription(await offerer.createOffer());
      await answerer.setLocalDescription(await answerer.createAnswer());
      const rejectedVideo = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "video");
      expect(rejectedVideo?.rejected).toBe(true);
      // Assert: local answer の確定で terminal stopped になる。
      expect(rejectedVideo?.stopped).toBe(true);
      expect(rejectedVideo?.currentDirection).toBe("stopped");
      const oldMid = rejectedVideo?.mid;

      const sender = answerer.addTrack(new MediaStreamTrack({ kind: "video" }));
      const nextOffer = parseSdp((await answerer.createOffer()).sdp);

      // Assert: reject 済み sender は再利用せず、同じ m-line index を新 MID で再利用する。
      expect(sender).not.toBe(rejectedVideo?.sender);
      expect(sender.stopped).toBe(false);
      expect(rejectedVideo?.sender.track).toBeFalsy();
      expect(answerer.getTransceivers()).toHaveLength(3);
      expect(rejectedVideo?.mid).toBeNull();
      expect(rejectedVideo?.mLineIndex).toBeUndefined();
      expect(
        nextOffer.media.filter((media) => media.kind === "video"),
      ).toHaveLength(1);
      expect(nextOffer.media[0]?.kind).toBe("video");
      expect(nextOffer.media[0]?.port).not.toBe(0);
      expect(nextOffer.media[0]?.rtp.muxId).not.toBe(oldMid);
      expect(getBundleItems(nextOffer)).toContain(
        nextOffer.media[0]?.rtp.muxId,
      );
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("inactive かつ reject 済み transceiver は確定後に stopped になり再利用される", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [useOPUS()], video: [useH264()] },
    });
    offerer.addTransceiver("video", { direction: "inactive" });
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: inactive かつ非対応 codec の video を reject して answer を確定させる。
      await answerer.setRemoteDescription(await offerer.createOffer());
      await answerer.setLocalDescription(await answerer.createAnswer());
      const rejectedVideo = answerer.getTransceivers()[0];
      expect(rejectedVideo.rejected).toBe(true);
      // Assert: codec reject の確定は direction 交渉と別に terminal stopped になる。
      expect(rejectedVideo.stopped).toBe(true);
      expect(rejectedVideo.currentDirection).toBe("stopped");
      const oldMid = rejectedVideo.mid;

      answerer.addTrack(new MediaStreamTrack({ kind: "video" }));
      const nextOffer = parseSdp((await answerer.createOffer()).sdp);

      // Assert: inactive reject 枠は置換せず、同じ m-line index を新 MID で再利用する。
      expect(rejectedVideo.rejected).toBe(true);
      expect(rejectedVideo.mid).toBeNull();
      expect(answerer.getTransceivers()).toHaveLength(2);
      expect(
        nextOffer.media.filter((media) => media.kind === "video"),
      ).toHaveLength(1);
      expect(nextOffer.media[0]?.port).not.toBe(0);
      expect(nextOffer.media[0]?.rtp.muxId).not.toBe(oldMid);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("removeTrack 後に足した新規 m-line でも RTP を受け取れる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const tracks = [0, 1, 2].map(() => new MediaStreamTrack({ kind: "video" }));

    try {
      // Arrange: sendonly video を 3 本交渉して接続する。
      offerer.addTransceiver(tracks[0], { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);
      const second = offerer.addTransceiver(tracks[1], {
        direction: "sendonly",
      });
      await negotiateOfferAnswer(offerer, answerer);
      offerer.addTransceiver(tracks[2], { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Act: 2 本目を removeTrack したあと、recycle せず 4 本目を足して再交渉する。
      offerer.removeTrack(second.sender);
      await negotiateOfferAnswer(offerer, answerer);
      const fourthTrack = new MediaStreamTrack({ kind: "video" });
      offerer.addTransceiver(fourthTrack, { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);
      const fourth = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mLineIndex === 3);
      const received = waitForRtp(fourth);
      sendTestRtp(fourthTrack, "fourth");

      // Assert: 新規 m-line は reject されず、RTP を受け取れる。
      await expect(received).resolves.toBeDefined();
      expect(fourth?.rejected).toBe(false);
      expect(parseSdp(offerer.localDescription?.sdp).media).toHaveLength(4);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});
