/**
 * werift ↔ Chrome の GCC/TWCC 帯域シミュレーション（CI 対象外）。
 *
 * - Chrome: recvonly + transport-cc（SDP 交渉）
 * - werift: sendonly + GccBandwidthEstimator + ICE send 上の仮想ボトルネック
 *
 * 実行: `cd e2e && npm run test:sim`
 */
import { peer, sleep } from "../../tests/fixture";

const LABEL = "sim_gcc_twcc_chrome";

describe("e2e/simulations/gcc-twcc-chrome", () => {
  it(
    "werift 側ボトルネック超過で GCC 帯域が下がり、追従後にドロップが減る",
    async () => {
      // Arrange
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const capacityBps = 200_000;
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // 合成 RTP（非本物 VP8）なので decode/再生は期待しない。
      // 受信は getStats の packetsReceived とサーバ側 TWCC サンプルで確認する。
      pc.ontrack = ({ track }) => {
        const video = document.createElement("video");
        video.srcObject = new MediaStream([track]);
        video.autoplay = true;
        video.muted = true;
        document.body.appendChild(video);
        void video.play().catch(() => {});
      };

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        peer
          .request(LABEL, { type: "candidate", payload: candidate })
          .catch(() => {});
      };

      pc.addTransceiver("video", { direction: "recvonly" });

      // Act: 交渉
      const offer = await peer.request(LABEL, {
        type: "init",
        payload: {
          capacityBps,
          startBitrateBps: 700_000,
          baseDelayMs: 40,
          // Larger queue so brief probe/ICE bursts do not dominate drop rate.
          maxQueueBytes: 64_000,
        },
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await peer.request(LABEL, {
        type: "answer",
        payload: pc.localDescription,
      });

      // 接続安定待ち
      await sleep(500);

      // Act 1: 容量超過の固定レートで輻輳誘発
      await peer.request(LABEL, {
        type: "startCongestion",
        payload: { targetBps: 700_000, payloadBytes: 800 },
      });
      await sleep(4_000);
      const congested = await peer.request(LABEL, {
        type: "markCongestionEnd",
      });

      // Assert 1: ボトルネックでロスが発生し、推定が下がっている
      // 日本語: werift 送信経路でドロップが発生していること
      expect(congested.outbound.dropped).toBeGreaterThan(0);
      // 日本語: TWCC 経由で onAvailableBitrate が少なくとも 1 回発火していること
      expect(congested.sampleCount).toBeGreaterThan(0);
      // 日本語: 推定が初期 700kbps 帯から明確に下がっていること
      expect(congested.lastBitrate).toBeLessThan(550_000);
      expect(congested.lastBitrate).toBeLessThan(capacityBps * 2.5);

      // Act 2: 推定帯域に追従。キュー排水と probe abort の settle 後に計測開始
      await peer.request(LABEL, { type: "startAdapt" });
      await sleep(1_500);
      const adaptBaseline = await peer.request(LABEL, {
        type: "markAdaptStart",
      });
      await sleep(4_000);
      const adapted = await peer.request(LABEL, { type: "snapshot" });

      // Assert 2: 適応後は送信ターゲットが容量近傍以下で、推定も開始 700kbps 帯から下がる
      // 日本語: 適応モードで target が capacity 以下に抑制されている
      expect(adapted.adaptMode).toBe(true);
      expect(adapted.targetBps).toBeLessThanOrEqual(capacityBps * 1.05);
      // 日本語: 最終推定が開始帯の高値に張り付いていない
      expect(adapted.lastBitrate).toBeLessThan(500_000);
      // 日本語: ゼロ張り付きではない（GCC 下限 ~10kbps 近傍までは許容）
      expect(adapted.lastBitrate).toBeGreaterThanOrEqual(10_000);
      // 日本語: 適応期は輻輳期よりドロップ率が厳密に低下する（追従後の輻輳緩和）
      const congRate =
        congested.outbound.enqueued > 0
          ? congested.outbound.dropped / congested.outbound.enqueued
          : 1;
      const adaptDropped = adapted.dropsDuringAdapt;
      const baselineEnq =
        adaptBaseline.enqueuedAtAdaptStart ?? congested.outbound.enqueued;
      const adaptEnqueued = Math.max(
        1,
        adapted.outbound.enqueued - baselineEnq,
      );
      const adaptRate = adaptDropped / adaptEnqueued;
      expect(adaptRate).toBeLessThan(congRate);
      // 日本語: 適応期の追加ドロップ絶対数も輻輳期より少ない
      expect(adaptDropped).toBeLessThan(congested.outbound.dropped);

      // 日本語: Chrome が RTP を受信していること（getStats）
      let packetsReceived = 0;
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && (report as any).kind === "video") {
          packetsReceived += Number((report as any).packetsReceived ?? 0);
        }
      });
      expect(packetsReceived).toBeGreaterThan(0);

      // 診断ログ
      // eslint-disable-next-line no-console
      console.log({ capacityBps, congested, adapted, packetsReceived });

      await peer.request(LABEL, { type: "done" }).catch(() => {});
      pc.close();
    },
    45_000,
  );
});
