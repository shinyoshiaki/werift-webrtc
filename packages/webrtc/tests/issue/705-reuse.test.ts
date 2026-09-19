import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import {
  createReuseScenario,
  getBundleItems,
  negotiateOfferAnswer,
  parseSdp,
  sendTestRtp,
  waitForConnection,
  waitForRtp,
} from "./705.helpers";

describe("#705 m-line reuse modes", () => {
  for (const bundlePolicy of ["max-bundle", "disable"] as const) {
    for (const separate of [false, true]) {
      test(`${bundlePolicy}: removeTrack/stop ${separate ? "別々" : "同時"}の交渉で2本を維持`, async () => {
        const { offerer, answerer, video, track } = await createReuseScenario({
          bundlePolicy,
        });
        const mid = video.mid;
        const index = video.mLineIndex!;
        try {
          // Act: removeTrack と stop を同じ交渉前、または別々の交渉前に行う。
          offerer.removeTrack(video.sender);
          if (separate) await negotiateOfferAnswer(offerer, answerer);
          video.stop();
          video.stop();
          await negotiateOfferAnswer(offerer, answerer);
          // Assert: 拒否交渉が完了し、旧 MID の位置が port 0 になる。
          expect(
            parseSdp(offerer.localDescription!.sdp).media[index].port,
          ).toBe(0);
          expect(video.stopped).toBe(true);
          expect(video.currentDirection).toBe("stopped");
          expect(video.sender.stopped).toBe(true);
          expect(video.receiver.stopped).toBe(true);
          // Act: 同じ kind の新規 transceiver を追加し、同じ位置で再交渉する。
          const next = offerer.addTransceiver(track, { direction: "sendonly" });
          await negotiateOfferAnswer(offerer, answerer);
          // Assert: m-line は2本、新しい MID、停止済みオブジェクトは再開しない。
          const sdp = parseSdp(offerer.localDescription!.sdp);
          expect(sdp.media).toHaveLength(2);
          expect(next.mLineIndex).toBe(index);
          expect(next.mid).not.toBe(mid);
          expect(sdp.media[index].port).not.toBe(0);
          expect(video.mid).toBeNull();
          expect(video.mLineIndex).toBeUndefined();
          expect(video.stopped).toBe(true);
          expect(
            answerer.getTransceivers().find((t) => t.mid === next.mid)
              ?.rejected,
          ).toBe(false);
          if (bundlePolicy !== "disable") {
            expect(getBundleItems(sdp)).not.toContain(mid);
            expect(getBundleItems(sdp)).toContain(next.mid);
          }
        } finally {
          await Promise.all([offerer.close(), answerer.close()]);
        }
      });
    }
  }

  for (const mLineReuse of ["compatible", "aggressive"] as const) {
    test(`${mLineReuse}: inactive の維持または従来の port 0 再利用を選択`, async () => {
      const { offerer, answerer, video, track } = await createReuseScenario({
        mLineReuse,
      });
      const mid = video.mid;
      try {
        // Act: stop を呼ばず removeTrack のみを交渉する。
        offerer.removeTrack(video.sender);
        await negotiateOfferAnswer(offerer, answerer);
        // Assert: モードで inactive の wire 表現が切り替わる。
        expect(parseSdp(offerer.localDescription!.sdp).media[1].port).toBe(
          mLineReuse === "aggressive" ? 0 : 9,
        );
        // Act: 新規 transceiver を追加する。
        const next = offerer.addTransceiver(track, { direction: "sendonly" });
        await negotiateOfferAnswer(offerer, answerer);
        // Assert: 積極モードのみ位置を再利用し、どちらも新 MID で受諾される。
        expect(parseSdp(offerer.localDescription!.sdp).media).toHaveLength(
          mLineReuse === "aggressive" ? 2 : 3,
        );
        expect(next.mid).not.toBe(mid);
        expect(next.mLineIndex).toBe(mLineReuse === "aggressive" ? 1 : 2);
      } finally {
        await Promise.all([offerer.close(), answerer.close()]);
      }
    });
  }

  test("stop の交渉が終わる前の新規追加は停止予定の位置を奪わない", async () => {
    const { offerer, answerer, video, track } = await createReuseScenario();
    try {
      // Act: 拒否の offer/answer 前に追加する。
      video.stop();
      offerer.addTransceiver(track, { direction: "sendonly" });
      const offer = parseSdp((await offerer.createOffer()).sdp);
      // Assert: 旧位置の port 0 と新規位置の両方を提示する。
      expect(offer.media).toHaveLength(3);
      expect(offer.media[1].port).toBe(0);
      expect(offer.media[2].port).not.toBe(0);
      expect(video.stopped).toBe(false);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("answerer の stop は自身の次の offer で拒否し再利用できる", async () => {
    const { offerer, answerer } = await createReuseScenario();
    const video = answerer.getTransceivers()[1];
    try {
      // Act: remote offer 適用後に stop しても、その answer は port 0 にしない。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      video.stop();
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      // Assert: stopping と stopped を区別して BUNDLE を壊さない。
      expect(parseSdp(answerer.localDescription!.sdp).media[1].port).not.toBe(
        0,
      );
      expect(video.stopped).toBe(false);
      // Act: answerer が offerer になって停止を交渉してから新規追加する。
      await negotiateOfferAnswer(answerer, offerer);
      const next = answerer.addTransceiver("video", { direction: "recvonly" });
      await negotiateOfferAnswer(answerer, offerer);
      // Assert: 役割が変わっても元の2本の中で再利用される。
      expect(parseSdp(answerer.localDescription!.sdp).media).toHaveLength(2);
      expect(next.mLineIndex).toBe(1);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("停止・再利用を繰り返しても新しい MID の RTP を受信できる", async () => {
    const { offerer, answerer, video, track } = await createReuseScenario(
      {},
      { videoFirst: true },
    );
    let current = video;
    const mids = new Set([video.mid]);
    try {
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      for (let i = 0; i < 3; i++) {
        // Act: BUNDLE の先頭を停止し、交渉完了後に新規 transceiver に置き換える。
        offerer.removeTrack(current.sender);
        current.stop();
        await negotiateOfferAnswer(offerer, answerer);
        // Assert: 停止中は残った audio が tag になる。
        expect(getBundleItems(parseSdp(offerer.localDescription!.sdp))).toEqual(
          ["1"],
        );
        current = offerer.addTransceiver(track, { direction: "sendonly" });
        await negotiateOfferAnswer(offerer, answerer);
        // Assert: 古い MID を使わず、本数を維持し、新しい receiver に RTP が届く。
        expect(parseSdp(offerer.localDescription!.sdp).media).toHaveLength(2);
        expect(mids.has(current.mid)).toBe(false);
        mids.add(current.mid);
        const receiving = waitForRtp(
          answerer.getTransceivers().find((t) => t.mid === current.mid),
        );
        sendTestRtp(track, `recycled-${i}`);
        const [packet] = await receiving;
        expect(packet.payload.toString()).toBe(`recycled-${i}`);
      }
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });

  test("既定モードと設定の検証、未関連付け stop の m-line 非生成", async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    try {
      // Assert: 既定は互換モードで、稼働中の切替と無効値は拒否する。
      expect(pc.getConfiguration().mLineReuse).toBe("compatible");
      expect(() => pc.setConfiguration({ mLineReuse: "aggressive" })).toThrow();
      expect(
        () => new RTCPeerConnection({ mLineReuse: "invalid" as any }),
      ).toThrow(TypeError);
      // Act: SDP に関連付ける前に停止する。
      const t = pc.addTransceiver(new MediaStreamTrack({ kind: "video" }));
      t.stop();
      // Assert: 新しい停止済み枠を SDP に追加しない。
      expect(parseSdp((await pc.createOffer()).sdp).media).toHaveLength(0);
    } finally {
      await pc.close();
    }
  });

  test("SCTP が先頭にあっても RTP の本来の index を再利用する", async () => {
    const { offerer, answerer, video, track } = await createReuseScenario(
      {},
      { dataFirst: true },
    );
    try {
      // Act: data/audio/video の video を止め、別の video に置き換える。
      offerer.removeTrack(video.sender);
      video.stop();
      await negotiateOfferAnswer(offerer, answerer);
      const next = offerer.addTransceiver(track, { direction: "sendonly" });
      await negotiateOfferAnswer(offerer, answerer);
      // Assert: application と audio を動かさず、index=2 を使う。
      const sdp = parseSdp(offerer.localDescription!.sdp);
      expect(sdp.media.map((m) => m.kind)).toEqual([
        "application",
        "audio",
        "video",
      ]);
      expect(next.mLineIndex).toBe(2);
      expect(sdp.media.every((m) => m.port !== 0)).toBe(true);
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  });
});
