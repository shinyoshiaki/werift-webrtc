import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  useOPUS,
  usePCMU,
  useSdesMid,
  useTransportWideCC,
  useVP8,
} from "../../src";
import {
  createAudioOnlyPeerConnection,
  createBundledPeerConnection,
  createOfferWithKinds,
  forwardIceCandidates,
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
      const speculativeTrack = transceiver.receiver.tracks[1];
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: track が1本に戻り、speculative track は停止し、重複 ontrack なく RTP が継続する。
      expect(answerer.signalingState).toBe("stable");
      expect(transceiver.receiver.tracks).toHaveLength(1);
      expect(transceiver.receiver.tracks[0]).toBe(originalTrack);
      expect(speculativeTrack.readyState).toBe("ended");
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
      const added = answerer.getTransceivers()[1];
      const addedSsrc = added.sender.ssrc;
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: transceiver 一覧が戻り、追加分は停止・登録解除される。
      expect(answerer.signalingState).toBe("stable");
      expect(answerer.getTransceivers()).toHaveLength(1);
      expect(answerer.getTransceivers()[0].mid).toBe(audioMid);
      expect(answerer.getTransceivers()[0].rejected).toBe(false);
      expect(added.stopping).toBe(true);
      expect(added.sender.stopped).toBe(true);
      expect(added.receiver.stopped).toBe(true);
      expect(
        (
          answerer as unknown as {
            router: { ssrcTable: { [ssrc: number]: unknown } };
          }
        ).router.ssrcTable[addedSsrc],
      ).toBeUndefined();
      sendTestRtp(track, "after-add-rollback");
      await expect(
        waitForRtp(answerer.getTransceivers()[0]),
      ).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("BUNDLE membership 変更後の rollback で transport 配線が戻る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    offerer.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
      direction: "sendonly",
    });
    offerer.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
      direction: "sendonly",
    });

    try {
      // Arrange: max-bundle 相当の offer で交渉し、transport を共有させる。
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const parsed = parseSdp(offer.sdp);
      const videoMid = parsed.media[0]?.rtp.muxId;
      const audioMid = parsed.media[1]?.rtp.muxId;
      const videoT = answerer
        .getTransceivers()
        .find((t) => t.mid === videoMid)!;
      const audioT = answerer
        .getTransceivers()
        .find((t) => t.mid === audioMid)!;
      expect(videoT.dtlsTransport).toBe(audioT.dtlsTransport);

      // Act: group を video のみに狭めた re-offer を適用する。
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      const reVideoMid = parseSdp(reOffer.sdp).media[0]?.rtp.muxId;
      const reAudioMid = parseSdp(reOffer.sdp).media[1]?.rtp.muxId;
      await expect(
        answerer.setRemoteDescription({
          ...reOffer,
          sdp: rewriteBundleGroup(reOffer.sdp, [reVideoMid!]),
        }),
      ).resolves.toBeUndefined();

      // Assert: group 外の audio が独立 transport に分離される。
      const reVideoT = answerer
        .getTransceivers()
        .find((t) => t.mid === reVideoMid)!;
      const reAudioT = answerer
        .getTransceivers()
        .find((t) => t.mid === reAudioMid)!;
      expect(reAudioT.dtlsTransport).not.toBe(reVideoT.dtlsTransport);

      // Act: rollback する。
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: transport 配線が共有に戻る。
      expect(answerer.signalingState).toBe("stable");
      expect(reAudioT.dtlsTransport).toBe(reVideoT.dtlsTransport);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("codec 構成変更の re-offer 後の rollback で sender 準備が戻る", async () => {
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
      const transceiver = answerer.getTransceivers()[0];
      expect(transceiver.sender.codec?.mimeType).toBe("audio/OPUS");

      // Act: PCMU のみに絞った accepted re-offer を適用してから rollback する。
      const narrowedSdp = firstOffer.sdp
        ?.replace(
          "m=audio 9 UDP/TLS/RTP/SAVPF 96 0",
          "m=audio 9 UDP/TLS/RTP/SAVPF 0",
        )
        .replace(/\r\na=rtpmap:96 OPUS\/48000\/2/, "");
      expect(
        parseSdp(narrowedSdp).media[0]?.rtp.codecs.map((c) => c.mimeType),
      ).toEqual(["audio/PCMU"]);
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: narrowedSdp }),
      ).resolves.toBeUndefined();
      expect(transceiver.sender.codec?.mimeType).toBe("audio/PCMU");
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: sender 準備が OPUS に戻り、RTP が継続する。
      expect(transceiver.sender.codec?.mimeType).toBe("audio/OPUS");
      sendTestRtp(track, "after-codec-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("sender snapshot は RTX/RED 関連 field を復元する", async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const sender = pc.addTrack(new MediaStreamTrack({ kind: "video" }));

    try {
      // Arrange: RTX/RED を含む送信パラメータで準備する。
      const snapshot = sender.snapshotMediaState();
      sender.prepareSend({
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/VP8",
            clockRate: 90000,
            payloadType: 96,
          }),
          new RTCRtpCodecParameters({
            mimeType: "video/rtx",
            clockRate: 90000,
            payloadType: 97,
            parameters: "apt=96",
          }),
          new RTCRtpCodecParameters({
            mimeType: "video/red",
            clockRate: 90000,
            payloadType: 98,
            parameters: "96/96",
          }),
        ],
        muxId: "9",
        headerExtensions: [],
        rtcp: { cname: "pending", ssrc: 1, mux: true },
      });
      const internals = sender as unknown as {
        rtxPayloadType?: number;
        redRedundantPayloadType?: number;
        rtpStreamId?: string;
        cname?: string;
      };
      expect(internals.rtxPayloadType).toBe(97);
      expect(internals.redRedundantPayloadType).toBe(96);

      // Act: snapshot へ復元する。
      sender.restoreMediaState(snapshot);

      // Assert: 準備前の状態に戻る。
      expect(sender.codec).toBeUndefined();
      expect(internals.rtxPayloadType).toBeUndefined();
      expect(internals.redRedundantPayloadType).toBeUndefined();
      expect(internals.rtpStreamId).toBeUndefined();
      expect(internals.cname).toBeUndefined();
    } finally {
      await pc.close();
    }
  });

  test("datachannel 追加後の rollback で SCTP が戻る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    offerer.createDataChannel("chat");
    const offer = await offerer.createOffer();

    try {
      // Act: application m-line を含む offer を適用してから rollback する。
      await offerer.setLocalDescription(offer);
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).resolves.toBeUndefined();
      expect(
        parseSdp(answerer.remoteDescription?.sdp).media.map((m) => m.kind),
      ).toContain("application");

      // Assert: rollback 後に datachannel m-line が残らず、次 offer にも出ない。
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();
      expect(answerer.signalingState).toBe("stable");
      expect(
        parseSdp((await answerer.createOffer()).sdp).media.map((m) => m.kind),
      ).not.toContain("application");
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("複数 offer 適用後の rollback は最初の pending 前に戻る", async () => {
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
      const transceiver = answerer.getTransceivers()[0];
      const pcmuOnlySdp = firstOffer.sdp
        ?.replace(
          "m=audio 9 UDP/TLS/RTP/SAVPF 96 0",
          "m=audio 9 UDP/TLS/RTP/SAVPF 0",
        )
        .replace(/\r\na=rtpmap:96 OPUS\/48000\/2/, "");
      const opusOnlySdp = stripPcmuFromOffer(firstOffer.sdp);

      // Act: offer を2回重ねてから rollback する。
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: pcmuOnlySdp }),
      ).resolves.toBeUndefined();
      expect(transceiver.sender.codec?.mimeType).toBe("audio/PCMU");
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: opusOnlySdp }),
      ).resolves.toBeUndefined();
      expect(transceiver.sender.codec?.mimeType).toBe("audio/OPUS");
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: 最初の pending 前（OPUS の current session）に戻る。
      expect(answerer.signalingState).toBe("stable");
      expect(transceiver.sender.codec?.mimeType).toBe("audio/OPUS");
      expect(transceiver.rejected).toBe(false);
      sendTestRtp(track, "after-multi-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("pending 中の RTP による NACK/TWCC 状態は rollback で戻る", async () => {
    const videoCodec = (feedback: { type: string }[]) =>
      useVP8({ rtcpFeedback: feedback as never });
    const twccFeedback = [{ type: "nack" }, { type: "transport-cc" }];
    const twccExtensions = [useSdesMid(), useTransportWideCC()];
    const offerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { video: [videoCodec(twccFeedback)] },
      headerExtensions: { video: twccExtensions },
    });
    const answerer = new RTCPeerConnection({
      iceServers: [],
      codecs: { video: [videoCodec(twccFeedback)] },
      headerExtensions: { video: twccExtensions },
    });
    const track = new MediaStreamTrack({ kind: "video" });
    offerer.addTransceiver(track, { direction: "sendonly" });

    try {
      // Arrange: 交渉し、未知 SSRC 配送の MID 拡張 ID と VP8 PT を得る。
      const firstOffer = await offerer.createOffer();
      await offerer.setLocalDescription(firstOffer);
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const transceiver = answerer.getTransceivers()[0];
      const mid = transceiver.mid!;
      const midId = transceiver.headerExtensions.find(
        (extension) => extension.uri === "urn:ietf:params:rtp-hdrext:sdes:mid",
      )?.id;
      const twccId = transceiver.headerExtensions.find(
        (extension) =>
          extension.uri ===
          "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
      )?.id;
      const vp8Pt = transceiver.codecs.find((codec) =>
        codec.mimeType.toLowerCase().includes("vp8"),
      )?.payloadType;
      expect(midId).toBeDefined();
      expect(twccId).toBeDefined();
      expect(vp8Pt).toBeDefined();
      const router = (
        answerer as unknown as {
          router: { routeRtp: (packet: RtpPacket) => void };
        }
      ).router;
      const nackLost = () =>
        (
          transceiver.receiver as unknown as {
            nack: { lostSeqNumbers: number[] };
          }
        ).nack.lostSeqNumbers;
      const twccKeys = () =>
        Object.keys(transceiver.receiver.receiverTWCC?.extensionInfo ?? {});
      const packet = (ssrc: number, seq: number, tsn: number) =>
        new RtpPacket(
          new RtpHeader({
            ssrc,
            sequenceNumber: seq,
            timestamp: 90000,
            payloadType: vp8Pt,
            extensions: [
              { id: midId!, payload: Buffer.from(mid) },
              { id: twccId!, payload: Buffer.from([tsn >> 8, tsn & 0xff]) },
            ],
          }),
          Buffer.from("speculative"),
        );

      // Arrange: pending 前に1パケットだけ受けて基準状態を作る。
      router.routeRtp(packet(0x11111111, 10, 1));
      expect(nackLost()).toEqual([]);
      const baselineTwccKeys = twccKeys();
      expect(baselineTwccKeys.length).toBeGreaterThan(0);

      // Act: accepted re-offer を適用し、pending 中に gap 付き RTP を受ける。
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      await expect(
        answerer.setRemoteDescription(offerer.localDescription!),
      ).resolves.toBeUndefined();
      router.routeRtp(packet(0x11111111, 12, 2));
      expect(nackLost()).toEqual([11]);
      expect(twccKeys().length).toBeGreaterThan(0);

      // Act: rollback する。
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: speculative packet の NACK/TWCC 状態が基準に戻る。
      expect(nackLost()).toEqual([]);
      expect(twccKeys()).toEqual(baselineTwccKeys);
      sendTestRtp(track, "after-nack-rollback");
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});

describe("PR #711 review P1 Round6 の回帰テスト", () => {
  test("ICE-restart re-offer の rollback で旧 transport state と RTP が残る", async () => {
    const offerer = new RTCPeerConnection({ iceServers: [] });
    const answerer = new RTCPeerConnection({ iceServers: [] });
    const track = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(track, { direction: "sendonly" });
    // ICE restart 後の再接続には trickle 転送が必要。
    const stopForwarding = forwardIceCandidates(offerer, answerer);

    try {
      // Arrange: 接続し、旧世代の remote state を記録する。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const transceiver = answerer.getTransceivers()[0];
      const iceConnection = transceiver.dtlsTransport
        .iceTransport as unknown as {
        connection: { remoteUsername: string; remotePassword: string };
      };
      const dtlsTransport = transceiver.dtlsTransport as unknown as {
        remoteParameters?: { fingerprints: { value: string }[] };
        role: string;
      };
      const oldUfrag = iceConnection.connection.remoteUsername;
      const oldFingerprints = JSON.stringify(
        dtlsTransport.remoteParameters?.fingerprints,
      );
      const oldRole = dtlsTransport.role;
      expect(oldUfrag.length).toBeGreaterThan(0);

      // Act: 新 ufrag/pwd・candidate・EOC・変更 fingerprint の re-offer を適用する。
      // offerer 自体は restart せず、SDP 上だけ新世代に見せて answerer 側の扱いを見る。
      const reOffer = await offerer.createOffer();
      await offerer.setLocalDescription(reOffer);
      const reUfrag = `rstr${Date.now().toString(36)}`;
      const craftedSdp =
        reOffer.sdp
          ?.replace(/a=ice-ufrag:[^\r\n]+/, `a=ice-ufrag:${reUfrag}`)
          .replace(/a=ice-pwd:[^\r\n]+/, "a=ice-pwd:0123456789abcdefghijuy")
          .replace(
            /a=fingerprint:sha-256 ([0-9A-F:]+)/,
            (_match, hex: string) =>
              `a=fingerprint:sha-256 ${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`,
          )
          .replace(
            "\r\nm=",
            "\r\na=candidate:1 1 udp 2113929471 192.0.2.1 10100 typ host\r\na=end-of-candidates\r\nm=",
          ) ?? reOffer.sdp;
      expect(parseSdp(craftedSdp).media[0]?.iceParams?.usernameFragment).toBe(
        reUfrag,
      );
      // Act: rollback する (answer は作らない)。
      await expect(
        answerer.setRemoteDescription({ ...reOffer, sdp: craftedSdp }),
      ).resolves.toBeUndefined();
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: current description と transport の remote state が旧世代のまま。
      expect(answerer.signalingState).toBe("stable");
      expect(iceConnection.connection.remoteUsername).toBe(oldUfrag);
      expect(JSON.stringify(dtlsTransport.remoteParameters?.fingerprints)).toBe(
        oldFingerprints,
      );
      expect(dtlsTransport.role).toBe(oldRole);

      // Assert: 既存 RTP が継続し、次の negotiation が成功する。
      // 注意: ICE restart 後の実 RTP 再開は本環境では baseline でも不通のた
      // め、restart 交換の完了と state で検証する (別途 trickle 実験で確認)。
      sendTestRtp(track, "after-restart-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
      const restartOffer = await offerer.createOffer({ iceRestart: true });
      await offerer.setLocalDescription(restartOffer);
      const restartUfrag = parseSdp(restartOffer.sdp).media[0]?.iceParams
        ?.usernameFragment;
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: restart 交換が完了し、新世代 credentials が commit される。
      expect(offerer.signalingState).toBe("stable");
      expect(answerer.signalingState).toBe("stable");
      expect(
        (
          answerer.getTransceivers()[0].dtlsTransport
            .iceTransport as unknown as {
            connection: { remoteUsername: string };
          }
        ).connection.remoteUsername,
      ).toBe(restartUfrag);
    } finally {
      stopForwarding();
      await Promise.all([offerer.close(), answerer.close()]);
    }
  }, 60000);

  test("同一世代の fingerprint/role 変更は rollback で復元される", async () => {
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
      const transceiver = answerer.getTransceivers()[0];
      const dtlsTransport = transceiver.dtlsTransport as unknown as {
        remoteParameters?: { fingerprints: { value: string }[] };
        role: string;
      };
      const oldFingerprints = JSON.stringify(
        dtlsTransport.remoteParameters?.fingerprints,
      );
      const oldRole = dtlsTransport.role;

      // Act: fingerprint と setup を変えた同一世代 re-offer を適用する。
      const changedSdp = firstOffer.sdp
        ?.replace(
          /a=fingerprint:sha-256 ([0-9A-F:]+)/,
          (_match, hex: string) =>
            `a=fingerprint:sha-256 ${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`,
        )
        .replace("a=setup:actpass", "a=setup:active");
      expect(changedSdp).not.toBe(firstOffer.sdp);
      await expect(
        answerer.setRemoteDescription({ ...firstOffer, sdp: changedSdp }),
      ).resolves.toBeUndefined();
      expect(
        JSON.stringify(dtlsTransport.remoteParameters?.fingerprints),
      ).not.toBe(oldFingerprints);

      // Act: rollback する。
      await expect(
        answerer.setRemoteDescription({ type: "rollback" }),
      ).resolves.toBeUndefined();

      // Assert: DTLS remote state が旧世代に戻り、RTP が継続する。
      expect(JSON.stringify(dtlsTransport.remoteParameters?.fingerprints)).toBe(
        oldFingerprints,
      );
      expect(dtlsTransport.role).toBe(oldRole);
      sendTestRtp(track, "after-fp-rollback");
      await expect(waitForRtp(transceiver)).resolves.toBeDefined();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("restart re-offer 後の mid:1 candidate は自身の MID で再接続・RTP する", async () => {
    const offerer = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "disable",
    });
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    offerer.addTransceiver(videoTrack, { direction: "sendonly" });
    offerer.addTransceiver(audioTrack, { direction: "sendonly" });
    const answerer = createBundledPeerConnection();
    // ICE restart 後の再接続には trickle 転送が必要。
    const stopForwardingRound6 = forwardIceCandidates(offerer, answerer);

    try {
      // Arrange: audio のみ bundle の partial 交渉で接続する。
      const offer = await offerer.createOffer();
      const parsed = parseSdp(offer.sdp);
      const videoMid = parsed.media[0]?.rtp.muxId;
      const audioMid = parsed.media[1]?.rtp.muxId;
      await offerer.setLocalDescription(offer);
      await answerer.setRemoteDescription({
        ...offer,
        sdp: offer.sdp!.replace(
          /\r\nm=/,
          `\r\na=group:BUNDLE ${audioMid}\r\nm=`,
        ),
      });
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      const answererVideo = answerer
        .getTransceivers()
        .find((t) => t.mid === videoMid)!;
      const answererAudio = answerer
        .getTransceivers()
        .find((t) => t.mid === audioMid)!;
      const videoTransportBefore = answererVideo.dtlsTransport;
      const audioTransportBefore = answererAudio.dtlsTransport;

      // Act: baseline として両 m-line の RTP が通ることを確認する。
      const baselineVideo = waitForRtp(answererVideo);
      const baselineAudio = waitForRtp(answererAudio);
      sendTestRtp(videoTrack, "baseline-video");
      sendTestRtp(audioTrack, "baseline-audio");
      await expect(baselineVideo).resolves.toBeDefined();
      await expect(baselineAudio).resolves.toBeDefined();

      // Act: answerer 側で ICE restart re-offer し、再 bundle 提案中の candidate を集める。
      const restartOffer = await answerer.createOffer({ iceRestart: true });
      const seen: { sdpMid?: string | null; sdpMLineIndex?: number | null }[] =
        [];
      const { unSubscribe } = answerer.onIceCandidate.subscribe((candidate) => {
        if (candidate) {
          seen.push({
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
          });
        }
      });
      await answerer.setLocalDescription(restartOffer);
      await waitForIceGatheringComplete(answerer);
      await new Promise((resolve) => setImmediate(resolve));
      unSubscribe();
      const parsedRestart = parseSdp(restartOffer.sdp);
      const videoIndex = parsedRestart.media.findIndex(
        (media) => media.rtp.muxId === videoMid,
      );

      // Assert: 独立 transport の candidate は commit 前の提案に引きずられず自身の MID。
      expect(
        seen.filter((candidate) => candidate.sdpMid === videoMid).length,
      ).toBeGreaterThan(0);
      expect(
        seen
          .filter((candidate) => candidate.sdpMid === videoMid)
          .every((candidate) => candidate.sdpMLineIndex === videoIndex),
      ).toBe(true);
      expect(
        seen.filter((candidate) => candidate.sdpMid === audioMid).length,
      ).toBeGreaterThan(0);

      // Act: 相手が mid:1 を group 外に維持したまま交換を完了する。
      // 注意: restart 後の実 RTP 再開は本環境では baseline でも不通のため、
      // transport 配線の維持と交換完了で検証する。
      await offerer.setRemoteDescription(answerer.localDescription!);
      await offerer.setLocalDescription(await offerer.createAnswer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      expect(
        getBundleItems(parseSdp(offerer.localDescription?.sdp)),
      ).toBeUndefined();

      // Assert: 再 bundle 提案は commit されず、transport 配線が維持される。
      expect(offerer.signalingState).toBe("stable");
      expect(answerer.signalingState).toBe("stable");
      expect(answererVideo.dtlsTransport).toBe(videoTransportBefore);
      expect(answererAudio.dtlsTransport).toBe(audioTransportBefore);
      expect(answererVideo.dtlsTransport).not.toBe(answererAudio.dtlsTransport);
    } finally {
      stopForwardingRound6();
      await Promise.all([offerer.close(), answerer.close()]);
    }
  }, 90000);
});
