import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import {
  createAudioOnlyPeerConnection,
  createBundledPeerConnection,
  createOfferWithKinds,
  getBundleItems,
  negotiateOfferAnswer,
  parseSdp,
  replaceMediaPortByMid,
  rewriteBundleGroup,
  sendTestRtp,
  waitForConnection,
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

  test("交渉前に removeTrack した sender を addTrack が再利用せず RTP を送れる", async () => {
    const offerer = createBundledPeerConnection();
    const answerer = createBundledPeerConnection();
    const track1 = new MediaStreamTrack({ kind: "video" });
    const track2 = new MediaStreamTrack({ kind: "video" });

    try {
      // Act: 交渉前に addTransceiver → removeTrack → addTrack する。
      const first = offerer.addTransceiver(track1, { direction: "sendonly" });
      offerer.removeTrack(first.sender);
      expect(first.sender.stopped).toBe(true);
      const sender = offerer.addTrack(track2);

      // Assert: 停止済み sender は再利用せず、使える sender を返す。
      expect(sender).not.toBe(first.sender);
      expect(sender.stopped).toBe(false);

      // Act: 交渉・接続して新しい track の RTP を送る。
      // 旧 sender の m-line (index 0) と新規 m-line (index 1) の2本になる。
      await negotiateOfferAnswer(offerer, answerer);
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(parseSdp(offerer.localDescription?.sdp).media).toHaveLength(2);
      const remote = answerer
        .getTransceivers()
        .find((transceiver) => transceiver.mLineIndex === 1);
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
