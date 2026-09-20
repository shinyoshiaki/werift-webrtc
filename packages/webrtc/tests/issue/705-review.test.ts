import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useOPUS,
  usePCMU,
} from "../../src";
import {
  createAudioOnlyPeerConnection,
  createBundledPeerConnection,
  createOfferWithKinds,
  getBundleItems,
  getSectionUfrag,
  negotiateOfferAnswer,
  parseSdp,
  replaceMediaPortByMid,
  rewriteBundleGroup,
  sendTestRtp,
  stripPcmuFromOffer,
  stripSsrcLines,
  waitForConnection,
  waitForIceCandidate,
  waitForIceGatheringComplete,
  waitForRtp,
} from "./705.helpers";

describe("PR #711 review P1指摘の回帰テスト", () => {
  test("answer の BUNDLE は offer の membership と tag 順を維持する", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "audio",
      "video",
    ]);
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: m-section 順 [0,1] に対し tag 順が [1,0] の正当な offer を適用する。
      const reordered = {
        ...offer,
        sdp: rewriteBundleGroup(offer.sdp, ["1", "0"]),
      };
      await expect(
        answerer.setRemoteDescription(reordered),
      ).resolves.toBeUndefined();
      const answer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: 両方 accept しても offered tag 順を作り替えない。
      expect(getBundleItems(parseSdp(reordered.sdp))).toEqual(["1", "0"]);
      expect(answer.media[0]?.port).not.toBe(0);
      expect(answer.media[1]?.port).not.toBe(0);
      expect(getBundleItems(answer)).toEqual(["1", "0"]);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("offer が一部 MID だけ bundle していても answer で勝手に束ねない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "audio",
      "video",
    ]);
    const answerer = new RTCPeerConnection({ iceServers: [] });

    try {
      // Act: audio のみ bundle した offer を適用する。
      const partial = {
        ...offer,
        sdp: rewriteBundleGroup(offer.sdp, ["0"]),
      };
      await expect(
        answerer.setRemoteDescription(partial),
      ).resolves.toBeUndefined();
      const answer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: 受け入れ済み video を BUNDLE に追加しない。
      expect(answer.media[0]?.port).not.toBe(0);
      expect(answer.media[1]?.port).not.toBe(0);
      expect(getBundleItems(answer)).toEqual(["0"]);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("offered tag の reject と subsequent negotiation で offered 順の tag を維持する", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();
    const reorderedSdp = rewriteBundleGroup(offer.sdp, ["1", "0"]);

    try {
      // Act: tag=1 を先頭にした offer で tagged 相当の video を reject する。
      await expect(
        answerer.setRemoteDescription({ ...offer, sdp: reorderedSdp }),
      ).resolves.toBeUndefined();
      const firstAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: reject した video を外し、offered 順の次の tag=1 を選ぶ。
      expect(firstAnswer.media[0]?.port).toBe(0);
      expect(firstAnswer.media[1]?.port).not.toBe(0);
      expect(getBundleItems(firstAnswer)).toEqual(["1"]);

      // Act: reject 確定後に同じ offered group の再 offer を適用する。
      await answerer.setLocalDescription(await answerer.createAnswer());
      await expect(
        answerer.setRemoteDescription({ ...offer, sdp: reorderedSdp }),
      ).resolves.toBeUndefined();
      const secondAnswer = parseSdp((await answerer.createAnswer()).sdp);

      // Assert: subsequent negotiation でも tag 制約を維持する。
      expect(secondAnswer.media[0]?.port).toBe(0);
      expect(secondAnswer.media[1]?.port).not.toBe(0);
      expect(getBundleItems(secondAnswer)).toEqual(["1"]);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("共通 codec の無い non-zero answer は SRD で失敗し記述を変えない", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const offer = await offerer.createOffer();

    try {
      // Arrange: 正常 answer を用意し、codec だけを非対応に書き換える。
      // PCMU が残ると共通 codec 扱いになるため、両方とも非対応に書き換える。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const validAnswer = await answerer.createAnswer();
      const badSdp = validAnswer.sdp
        ?.replace(/opus\/48000\/2/i, "G722/8000")
        .replace(/PCMU\/8000/i, "PCMA/8000");
      expect(badSdp).not.toBe(validAnswer.sdp);
      const beforeLocalSdp = offerer.localDescription?.sdp;

      // Act: 共通 codec の無い non-zero answer を適用する。
      await expect(
        offerer.setRemoteDescription({ ...validAnswer, sdp: badSdp }),
      ).rejects.toThrow();

      // Assert: signaling と記述は元の状態を保つ。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.localDescription?.sdp).toBe(beforeLocalSdp);
      expect(offerer.remoteDescription).toBeNull();

      // Act: 同じ codec 不一致でも port 0 なら受理できる（対照ケース）。
      const answerMid = parseSdp(validAnswer.sdp).media[0]?.rtp.muxId;
      const rejectedSdp = replaceMediaPortByMid(badSdp, answerMid!, 0);
      await expect(
        offerer.setRemoteDescription({ ...validAnswer, sdp: rejectedSdp }),
      ).resolves.toBeUndefined();

      // Assert: port 0 answer は受理され stable になる。
      expect(offerer.signalingState).toBe("stable");
      expect(parseSdp(offerer.remoteDescription?.sdp).media[0]?.port).toBe(0);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("共通 codec の無い non-zero pranswer も SRD で失敗する", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const offer = await offerer.createOffer();

    try {
      // Arrange: 正常 answer を用意し、codec だけを非対応に書き換える。
      // PCMU が残ると共通 codec 扱いになるため、両方とも非対応に書き換える。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const validAnswer = await answerer.createAnswer();
      const badSdp = validAnswer.sdp
        ?.replace(/opus\/48000\/2/i, "G722/8000")
        .replace(/PCMU\/8000/i, "PCMA/8000");
      expect(badSdp).not.toBe(validAnswer.sdp);
      const beforeLocalSdp = offerer.localDescription?.sdp;

      // Act: 共通 codec の無い non-zero pranswer を適用する。
      await expect(
        offerer.setRemoteDescription({ type: "pranswer", sdp: badSdp }),
      ).rejects.toThrow();

      // Assert: signaling と記述は元の状態を保つ。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.localDescription?.sdp).toBe(beforeLocalSdp);
      expect(offerer.remoteDescription).toBeNull();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("pranswer の port 0 では pipeline を維持し final answer で確定する", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: opus で交渉・接続し、offerer 側の送信 pipeline を作る。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const transceiver = offerer.getTransceivers()[0];
      expect(transceiver.sender.codec).toBeDefined();

      // Act: pending の local offer に対し、port 0 の pranswer を適用する。
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      const mid = parseSdp(reOffer.sdp).media[0]?.rtp.muxId;
      const zeroSdp = replaceMediaPortByMid(reOffer.sdp, mid!, 0);
      await expect(
        offerer.setRemoteDescription({ type: "pranswer", sdp: zeroSdp }),
      ).resolves.toBeUndefined();

      // Assert: provisional な拒否では pipeline を維持し、確定しない。
      expect(offerer.signalingState).toBe("have-remote-pranswer");
      expect(transceiver.rejected).toBe(true);
      expect(transceiver.stopping).toBe(false);
      expect(transceiver.stopped).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();

      // Act: 同じ内容の final answer を適用する。
      await expect(
        offerer.setRemoteDescription({ type: "answer", sdp: zeroSdp }),
      ).resolves.toBeUndefined();

      // Assert: final answer で初めて pipeline が解除され stopped になる。
      expect(offerer.signalingState).toBe("stable");
      expect(transceiver.sender.codec).toBeUndefined();
      expect(transceiver.stopped).toBe(true);
      expect(transceiver.currentDirection).toBe("stopped");
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("remote の port 0 answer でも transceiver は stopped になる", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [], video: [] },
    });

    try {
      // Act: 共通 codec を持たない answerer に reject させ、その answer を適用する。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      expect(parseSdp(answer.sdp).media[0]?.port).toBe(0);
      await answerer.setLocalDescription(answer);
      await expect(
        offerer.setRemoteDescription(answerer.localDescription!),
      ).resolves.toBeUndefined();
      const transceiver = offerer.getTransceivers()[0];

      // Assert: offerer 側も terminal stopped で stable になる。
      expect(offerer.signalingState).toBe("stable");
      expect(transceiver.rejected).toBe(true);
      expect(transceiver.stopped).toBe(true);
      expect(transceiver.currentDirection).toBe("stopped");
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("reject 確定の SLD では negotiationneeded を再発火させない", async () => {
    const { pc: offerer, offer } = await createOfferWithKinds([
      "video",
      "audio",
    ]);
    const answerer = createAudioOnlyPeerConnection();
    const onNegotiationNeeded = vi.fn();

    try {
      // Arrange: 非対応 video を含む offer を適用し、SLD 直前に監視を付ける。
      await answerer.setRemoteDescription(offer);
      const videoTransceiver = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "video");
      expect(videoTransceiver?.rejected).toBe(true);
      answerer.onnegotiationneeded = onNegotiationNeeded;
      const answer = await answerer.createAnswer();

      // Act: SRD 時の stale 発火を流して数え直し、port 0 answer を適用して確定させる。
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      onNegotiationNeeded.mockClear();
      await answerer.setLocalDescription(answer);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: 確定処理は terminal stop するが、新しい交渉は要求しない。
      expect(videoTransceiver?.stopped).toBe(true);
      expect(onNegotiationNeeded).not.toHaveBeenCalled();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("交渉前に removeTrack しても addTrack で RTP を送れる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const track1 = new MediaStreamTrack({ kind: "video" });
    const track2 = new MediaStreamTrack({ kind: "video" });

    try {
      // Act: 交渉前に addTransceiver → removeTrack → addTrack する。
      // removeTrack は terminal stop ではなく detach なので sender は生き残る。
      const first = offerer.addTransceiver(track1, { direction: "sendonly" });
      offerer.removeTrack(first.sender);
      expect(first.sender.stopped).toBe(false);
      expect(first.sender.track).toBeNull();
      const sender = offerer.addTrack(track2);

      // Assert: detach された live sender が再利用され、使えるまま残る。
      expect(sender).toBe(first.sender);
      expect(sender.stopped).toBe(false);

      // Act: 交渉・接続して新しい track の RTP を送る。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(parseSdp(offerer.localDescription?.sdp).media).toHaveLength(1);
      const remote = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mLineIndex === 0);
      const received = waitForRtp(remote);
      sendTestRtp(track2, "retrack");

      // Assert: 相手側で実 RTP を受信できる。
      await expect(received).resolves.toBeDefined();
      expect(remote?.rejected).toBe(false);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});

describe("PR #711 review P1 Round2 の回帰テスト", () => {
  test("partial BUNDLE では group 外 m-line が独立 transport を維持し両方で RTP が通る", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "disable",
    });
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(videoTrack, { direction: "sendonly" });
    offerer.addTransceiver(audioTrack, { direction: "sendonly" });
    const answerer = createBundledPeerConnection();
    const offer = await offerer.createOffer();
    const parsed = parseSdp(offer.sdp);
    const videoMid = parsed.media[0]?.rtp.muxId;
    const audioMid = parsed.media[1]?.rtp.muxId;
    const seenCandidates: { sdpMid?: string | null }[] = [];
    const { unSubscribe } = answerer.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        seenCandidates.push({ sdpMid: candidate.sdpMid });
      }
    });

    try {
      // Act: offerer は独立 transport のまま、answerer 側だけ audio を bundle する。
      // disable offer には group 行が無いため、audio MID の group 行を挿入する。
      await offerer.setLocalDescription(offer);
      const partialSdp = offer.sdp!.replace(
        /\r\nm=/,
        `\r\na=group:BUNDLE ${audioMid}\r\nm=`,
      );
      await expect(
        answerer.setRemoteDescription({ ...offer, sdp: partialSdp }),
      ).resolves.toBeUndefined();
      const answer = await answerer.createAnswer();
      const parsedAnswer = parseSdp(answer.sdp);
      const answerAudio = parsedAnswer.media[1];
      const answerVideo = parsedAnswer.media[0];
      const answererAudio = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mid === audioMid);
      const answererVideo = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mid === videoMid);

      // Assert: group は audio のみ。video は受け入れつつ bundle しない。
      // 分割 transport は credentials を引き継ぐため ufrag は一致しうるが、
      // transport/DTLS オブジェクトは独立している。
      expect(getBundleItems(parsedAnswer)).toEqual([audioMid]);
      expect(answerAudio?.port).not.toBe(0);
      expect(answerVideo?.port).not.toBe(0);
      expect(getSectionUfrag(answer.sdp, audioMid!)).toBeDefined();
      expect(getSectionUfrag(answer.sdp, videoMid!)).toBeDefined();
      expect(answererAudio?.dtlsTransport).toBeDefined();
      expect(answererVideo?.dtlsTransport).toBeDefined();
      expect(answererAudio?.dtlsTransport).not.toBe(
        answererVideo?.dtlsTransport,
      );

      // Act: 交換を完了して両 transport で接続・受信する。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      await waitForIceGatheringComplete(answerer);
      const videoReceived = waitForRtp(answererVideo);
      const audioReceived = waitForRtp(answererAudio);
      sendTestRtp(videoTrack, "partial-video");
      sendTestRtp(audioTrack, "partial-audio");

      // Assert: 両 m-line で実 RTP が通り、trickle も各 MID で来る。
      await expect(videoReceived).resolves.toBeDefined();
      await expect(audioReceived).resolves.toBeDefined();
      expect(seenCandidates.map((c) => c.sdpMid)).toContain(videoMid);
      expect(seenCandidates.map((c) => c.sdpMid)).toContain(audioMid);
    } finally {
      unSubscribe();
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("先頭 tag reject 後の answer でも accepted tag の transport/candidate で接続できる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createAudioOnlyPeerConnection();
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(videoTrack, { direction: "sendonly" });
    offerer.addTransceiver(audioTrack, { direction: "sendonly" });

    try {
      // Act: video を reject する answer で tag を audio へ移して接続する。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const parsedOffer = parseSdp(offerer.localDescription?.sdp);
      const audioMid = parsedOffer.media[1]?.rtp.muxId;
      const received = waitForRtp(
        answerer
          .getTransceivers()
          .find((transceiver) => transceiver.mid === audioMid),
      );
      sendTestRtp(audioTrack, "tagged");

      // Assert: accepted tag 側の transport で RTP が通る。
      await expect(received).resolves.toBeDefined();
      expect(getBundleItems(parseSdp(answerer.localDescription?.sdp))).toEqual([
        audioMid,
      ]);

      // Act: ICE restart 後の新規 candidate が negotiated tag を使う。
      const restartOffer = await offerer.createOffer({ iceRestart: true });
      const freshCandidate = waitForIceCandidate(offerer);
      await offerer.setLocalDescription(restartOffer);
      const candidate = await freshCandidate;
      const parsedRestart = parseSdp(restartOffer.sdp);

      // Assert: reject 済み先頭ではなく accepted audio MID で送られる。
      expect(candidate.sdpMid).toBe(audioMid);
      expect(candidate.sdpMLineIndex).toBe(
        parsedRestart.media.findIndex((media) => media.rtp.muxId === audioMid),
      );

      // Act: restart 交換を完了して後片付けする。
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("offer で絞った codec 以外だけの final answer は失敗し pending を保つ", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [useOPUS(), usePCMU({ direction: "recvonly" })] },
    });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const offer = await offerer.createOffer();

    try {
      // Arrange: sendonly offer から PCMU が落ち、pending は OPUS のみになる。
      expect(
        parseSdp(offer.sdp).media[0]?.rtp.codecs.map((codec) => codec.mimeType),
      ).toEqual(["audio/OPUS"]);
      await offerer.setLocalDescription(offer);
      // SLD で description が補完されるため、以後の不変比較の基準は SLD 後の値にする。
      const beforeLocalSdp = offerer.localDescription?.sdp;
      await answerer.setRemoteDescription(offer);
      const validAnswer = await answerer.createAnswer();
      // Act: config にはあるが offer に無い PCMU だけの answer を適用する。
      const badSdp = validAnswer.sdp?.replace(/OPUS\/48000\/2/i, "PCMU/8000");
      expect(badSdp).not.toBe(validAnswer.sdp);
      await expect(
        offerer.setRemoteDescription({ ...validAnswer, sdp: badSdp }),
      ).rejects.toThrow();

      // Assert: have-local-offer と pending local offer がそのまま残る。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.localDescription?.sdp).toBe(beforeLocalSdp);
      expect(offerer.remoteDescription).toBeNull();

      // Act: 同条件の pranswer も失敗する（対照ケース）。
      await expect(
        offerer.setRemoteDescription({ type: "pranswer", sdp: badSdp }),
      ).rejects.toThrow();

      // Assert: pranswer でも状態は変わらない。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.localDescription?.sdp).toBe(beforeLocalSdp);
      expect(offerer.remoteDescription).toBeNull();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("交渉済み sender を removeTrack 後に同じ sender で再開できる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const track1 = new MediaStreamTrack({ kind: "video" });
    const track2 = new MediaStreamTrack({ kind: "video" });
    const transceiver = offerer.addTransceiver(track1, {
      direction: "sendonly",
    });

    try {
      // Arrange: 交渉・接続して MID/index を確定させる。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const mid = transceiver.mid;
      const mLineIndex = transceiver.mLineIndex;

      // Act: removeTrack 後に同じ sender へ差し替えて direction を復帰する。
      offerer.removeTrack(transceiver.sender);
      expect(transceiver.sender.stopped).toBe(false);
      await transceiver.sender.replaceTrack(track2);
      transceiver.direction = "sendonly";
      await negotiateOfferAnswer(offerer, answerer);

      // Assert: 同一 MID/m-line のまま再開し、RTP が通る。
      expect(transceiver.mid).toBe(mid);
      expect(transceiver.mLineIndex).toBe(mLineIndex);
      expect(
        parseSdp(offerer.localDescription?.sdp).media.filter(
          (media) => media.kind === "video",
        ),
      ).toHaveLength(1);
      expect(
        parseSdp(offerer.localDescription?.sdp).media[mLineIndex!]?.port,
      ).not.toBe(0);
      const received = waitForRtp(
        answerer.getTransceivers().find((t) => t.mid === mid),
      );
      sendTestRtp(track2, "resumed");

      // Assert: 差し替えた track の RTP が相手に届く。
      await expect(received).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("remote answer の reject で stable に戻っても negotiationneeded は発火しない", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("audio", { direction: "sendonly" });
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { audio: [], video: [] },
    });
    const onNegotiationNeeded = vi.fn();

    try {
      // Arrange: local offer を確定させ、port 0 answer を用意する。
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offer);
      const answer = await answerer.createAnswer();
      expect(parseSdp(answer.sdp).media[0]?.port).toBe(0);
      await answerer.setLocalDescription(answer);
      offerer.onnegotiationneeded = onNegotiationNeeded;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      onNegotiationNeeded.mockClear();

      // Act: port 0 の remote final answer を適用する。
      await expect(
        offerer.setRemoteDescription(answerer.localDescription!),
      ).resolves.toBeUndefined();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: stable に戻っても余分な event は発火しない。
      expect(offerer.signalingState).toBe("stable");
      expect(offerer.getTransceivers()[0]?.stopped).toBe(true);
      expect(onNegotiationNeeded).not.toHaveBeenCalled();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("remote port 0 re-offer から local answer まで余分な event は発火しない", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });
    const onNegotiationNeeded = vi.fn();

    try {
      // Arrange: opus で交渉する。同一 ufrag のまま再 offer できるよう初回 offer を保持する。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Act: 同一 m-line を port 0 にした再 offer から answer まで適用する。
      // ICE restart を起こさない同一 ufrag にし、protocol-driven stop の副作用だけを見る。
      const mid = parseSdp(firstOffer.sdp).media[0]?.rtp.muxId;
      const zeroSdp = replaceMediaPortByMid(firstOffer.sdp, mid!, 0);
      answerer.onnegotiationneeded = onNegotiationNeeded;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      onNegotiationNeeded.mockClear();
      await answerer.setRemoteDescription({ ...firstOffer, sdp: zeroSdp });
      await answerer.setLocalDescription(await answerer.createAnswer());
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: 拒否の確定まで余分な event は発火しない。
      expect(parseSdp(answerer.localDescription?.sdp).media[0]?.port).toBe(0);
      expect(answerer.getTransceivers()[0]?.stopped).toBe(true);
      expect(onNegotiationNeeded).not.toHaveBeenCalled();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("明示的 transceiver.stop() は negotiationneeded を発火させる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const track = new MediaStreamTrack({ kind: "video" });
    const transceiver = offerer.addTransceiver(track, {
      direction: "sendonly",
    });
    const onNegotiationNeeded = vi.fn();

    try {
      // Arrange: 交渉して stable にする。
      await negotiateOfferAnswer(offerer, answerer);
      expect(offerer.signalingState).toBe("stable");
      offerer.onnegotiationneeded = onNegotiationNeeded;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      onNegotiationNeeded.mockClear();

      // Act: application が明示的に stop する。
      transceiver.stop();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: 対照ケースとして negotiation が要求される。
      expect(onNegotiationNeeded).toHaveBeenCalled();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("unsupported re-offer 後の rollback で current session が復元される", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: 同一 ufrag のまま再 offer できるよう初回 offer を保持して接続する。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Act: 非対応 codec の re-offer を適用してから rollback する。
      const unsupportedSdp = firstOffer.sdp
        ?.replace(/OPUS\/48000\/2/i, "G722/8000")
        .replace(/PCMU\/8000/i, "PCMA/8000");
      await answerer.setRemoteDescription({
        ...firstOffer,
        sdp: unsupportedSdp,
      });
      const pending = answerer.getTransceivers()[0];
      expect(pending.rejected).toBe(true);
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();
      const transceiver = answerer.getTransceivers()[0];

      // Assert: rejected/codec が戻り、pipeline と次 offer が壊れない。
      expect(answerer.signalingState).toBe("stable");
      expect(transceiver.rejected).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();
      expect(transceiver.receiver.tracks.length).toBeGreaterThan(0);
      expect(
        parseSdp((await answerer.createOffer()).sdp).media[0]?.port,
      ).not.toBe(0);

      // Assert: 元 codec の RTP が継続する。
      sendTestRtp(track, "after-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("port 0 re-offer 後の rollback で停止せず current session が復元される", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: 同一 ufrag のまま再 offer できるよう初回 offer を保持して接続する。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Act: port 0 の re-offer を適用してから rollback する。
      const mid = parseSdp(firstOffer.sdp).media[0]?.rtp.muxId;
      const zeroSdp = replaceMediaPortByMid(firstOffer.sdp, mid!, 0);
      await answerer.setRemoteDescription({ ...firstOffer, sdp: zeroSdp });
      const pending = answerer.getTransceivers()[0];
      expect(pending.rejected).toBe(true);
      expect(pending.stopping).toBe(false);
      expect(pending.stopped).toBe(false);
      expect(pending.sender.codec).toBeDefined();
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();
      const transceiver = answerer.getTransceivers()[0];

      // Assert: terminal stop が残らず、pipeline と次 offer が壊れない。
      expect(answerer.signalingState).toBe("stable");
      expect(transceiver.rejected).toBe(false);
      expect(transceiver.stopping).toBe(false);
      expect(transceiver.stopped).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();
      expect(transceiver.receiver.tracks.length).toBeGreaterThan(0);
      expect(
        parseSdp((await answerer.createOffer()).sdp).media[0]?.port,
      ).not.toBe(0);

      // Assert: 元 codec の RTP が継続する。
      sendTestRtp(track, "after-zero-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("port 0 pranswer 後の rollback で pending offer が残る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: 交渉し、offerer が再 offer を pending にする。
      await negotiateOfferAnswer(offerer, answerer);
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      const mid = parseSdp(reOffer.sdp).media[0]?.rtp.muxId;

      // Act: port 0 の pranswer を適用してから rollback する。
      const zeroSdp = replaceMediaPortByMid(reOffer.sdp, mid!, 0);
      await expect(
        offerer.setRemoteDescription({ type: "pranswer", sdp: zeroSdp }),
      ).resolves.toBeUndefined();
      const pending = offerer.getTransceivers()[0];
      expect(offerer.signalingState).toBe("have-remote-pranswer");
      expect(pending.rejected).toBe(true);
      expect(pending.stopping).toBe(false);
      await expect(
        offerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: have-local-offer に戻り、pending offer と pipeline が残る。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(offerer.localDescription?.sdp).toBe(reOffer.sdp);
      const transceiver = offerer.getTransceivers()[0];
      expect(transceiver.rejected).toBe(false);
      expect(transceiver.stopping).toBe(false);
      expect(transceiver.stopped).toBe(false);
      expect(transceiver.sender.codec).toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("SSRC-less m-line の再交渉でも track と ontrack は増えない", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const track = new MediaStreamTrack({ kind: "video" });
    offerer.addTransceiver(track, { direction: "sendonly" });
    const onTrack = vi.fn();
    answerer.ontrack = onTrack;
    const offer = await offerer.createOffer();

    try {
      // Act: a=ssrc の無い offer を適用して answer する。
      await offerer.setLocalDescription(offer);
      await expect(
        answerer.setRemoteDescription({
          ...offer,
          sdp: stripSsrcLines(offer.sdp),
        }),
      ).resolves.toBeUndefined();
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const transceiver = answerer.getTransceivers()[0];
      const firstTrack = transceiver.receiver.tracks[0];
      expect(firstTrack).toBeDefined();
      expect(onTrack).toHaveBeenCalledTimes(1);

      // Act: 同一 m-line を SSRC-less のまま再 offer する。
      const offer2 = await offerer.createOffer();
      await offerer.setLocalDescription(offer2);
      await expect(
        answerer.setRemoteDescription({
          ...offer2,
          sdp: stripSsrcLines(offer2.sdp),
        }),
      ).resolves.toBeUndefined();

      // Assert: placeholder track は1本のまま、ontrack も増えない。
      expect(transceiver.receiver.tracks).toHaveLength(1);
      expect(transceiver.receiver.tracks[0]).toBe(firstTrack);
      expect(onTrack).toHaveBeenCalledTimes(1);

      // Act: 未知 SSRC の RTP を MID で配送する。
      const mid = parseSdp(offer2.sdp).media[0]?.rtp.muxId;
      const midExtId = transceiver.headerExtensions.find(
        (extension) => extension.uri === "urn:ietf:params:rtp-hdrext:sdes:mid",
      )?.id;
      const vp8Pt = transceiver.codecs.find((codec) =>
        codec.mimeType.toLowerCase().includes("vp8"),
      )?.payloadType;
      expect(midExtId).toBeDefined();
      expect(vp8Pt).toBeDefined();
      const received = waitForRtp(transceiver);
      (
        answerer as unknown as {
          router: { routeRtp: (packet: RtpPacket) => void };
        }
      ).router.routeRtp(
        new RtpPacket(
          new RtpHeader({
            ssrc: 0x12345678,
            payloadType: vp8Pt,
            extensions: [{ id: midExtId!, payload: Buffer.from(mid!) }],
          }),
          Buffer.from("unknown-ssrc"),
        ),
      );

      // Assert: 同じ track に届く。
      await expect(received).resolves.toBeDefined();
      expect(transceiver.receiver.tracks).toHaveLength(1);
      expect(transceiver.receiver.tracks[0]).toBe(firstTrack);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("MID 未設定の同種 transceiver が複数あっても各 m-line に割り当てる", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver("video", { direction: "sendonly" });
    offerer.addTransceiver("video", { direction: "sendonly" });
    const offer = await offerer.createOffer();
    const answerer = new RTCPeerConnection({ iceServers: [] });
    answerer.addTransceiver("video", { direction: "recvonly" });
    answerer.addTransceiver("video", { direction: "recvonly" });

    try {
      // Act: MID 未確定の同種 transceiver 2本に 2 m-line offer を適用する。
      await expect(
        answerer.setRemoteDescription(offer),
      ).resolves.toBeUndefined();
      const mids = answerer.getTransceivers().map((t) => t.mid);
      const answer = await answerer.createAnswer();

      // Assert: 各 m-line が別 transceiver に割当たり、answer を組める。
      expect(new Set(mids).size).toBe(2);
      expect(
        parseSdp(answer.sdp)
          .media.map((media) => media.rtp.muxId)
          .sort(),
      ).toEqual([...mids].sort());
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("SSRC 変更の accepted re-offer 後の rollback で track が戻る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });
    const onTrack = vi.fn();
    answerer.ontrack = onTrack;

    try {
      // Arrange: 同一 ufrag のまま再 offer できるよう初回 offer を保持して接続する。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const transceiver = answerer.getTransceivers()[0];
      const originalTrack = transceiver.receiver.tracks[0];
      expect(onTrack).toHaveBeenCalledTimes(1);

      // Act: SSRC を変えた accepted re-offer を適用してから rollback する。
      const oldSsrc = offerer.getTransceivers()[0].sender.ssrc;
      const reSdp = firstOffer.sdp
        ?.split("\r\n")
        .map((line) =>
          line.startsWith(`a=ssrc:${oldSsrc}`)
            ? line.replace(`a=ssrc:${oldSsrc}`, "a=ssrc:23456789")
            : line,
        )
        .join("\r\n");
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: reSdp }),
      ).resolves.toBeUndefined();
      expect(transceiver.receiver.tracks).toHaveLength(2);
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: track が1本に戻り、重複 ontrack なく RTP が継続する。
      expect(answerer.signalingState).toBe("stable");
      expect(transceiver.receiver.tracks).toHaveLength(1);
      expect(transceiver.receiver.tracks[0]).toBe(originalTrack);
      expect(onTrack).toHaveBeenCalledTimes(2);
      expect(
        parseSdp((await answerer.createOffer()).sdp).media[0]?.port,
      ).not.toBe(0);
      sendTestRtp(track, "after-ssrc-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("新規 remote transceiver 追加後の rollback で一覧が戻る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: audio 1本で交渉・接続する。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const audioMid = answerer.getTransceivers()[0].mid;
      expect(answerer.getTransceivers()).toHaveLength(1);

      // Act: video を追加した re-offer を適用してから rollback する。
      offerer.addTransceiver("video", { direction: "sendonly" });
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).resolves.toBeUndefined();
      expect(answerer.getTransceivers()).toHaveLength(2);
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: transceiver 一覧が戻り、既存 session が壊れない。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.getTransceivers()).toHaveLength(1);
      expect(answerer.getTransceivers()[0].mid).toBe(audioMid);
      expect(answerer.getTransceivers()[0].rejected).toBe(false);
      sendTestRtp(track, "after-add-rollback");
      await expect(
        waitForRtp(answerer.getTransceivers()[0]),
      ).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});
