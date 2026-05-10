import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RTCPeerConnection } from "../../src";
import {
  type RTCPeerConnectionStats,
  RTCStatsReport,
} from "../../src/media/stats";
import { MediaStreamTrack } from "../../src/media/track";
import { createDataChannelPair } from "../utils";

describe("RTCPeerConnection.getStats() - Comprehensive Tests", () => {
  describe("Basic Functionality", () => {
    let pc1: RTCPeerConnection;
    let pc2: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
      await pc2.close();
    });

    // RTCStatsReportインスタンスの正常な生成とMap継承の確認
    test("getStats() returns RTCStatsReport instance", async () => {
      const stats = await pc1.getStats();
      expect(stats).toBeInstanceOf(RTCStatsReport);
      expect(stats).toBeInstanceOf(Map);
    });

    // nullセレクターで全統計情報が取得できることを確認
    test("getStats() with null selector returns all stats", async () => {
      const stats = await pc1.getStats(null);
      expect(stats).toBeInstanceOf(RTCStatsReport);

      // Should contain peer-connection stats
      const pcStats = Array.from(stats.values()).find(
        (stat) => stat.type === "peer-connection",
      );
      expect(pcStats).toBeDefined();
    });

    // 全統計オブジェクトが必須プロパティ（id, timestamp, type）を持つことを確認
    test("stats have required properties", async () => {
      const stats = await pc1.getStats();

      for (const [id, stat] of stats) {
        // All stats should have basic properties
        expect(stat.id).toBe(id);
        expect(typeof stat.timestamp).toBe("number");
        expect(stat.timestamp).toBeGreaterThan(0);
        expect(typeof stat.type).toBe("string");
      }
    });

    // 統計オブジェクトのIDが重複しないことを確認
    test("stats IDs are unique", async () => {
      const stats = await pc1.getStats();

      const ids = Array.from(stats.keys());
      const uniqueIds = new Set(ids);

      expect(ids.length).toBe(uniqueIds.size);
    });

    // 連続したgetStats()呼び出しでタイムスタンプが単調増加することを確認
    test("consecutive getStats() calls have increasing timestamps", async () => {
      const stats1 = await pc1.getStats();

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const stats2 = await pc1.getStats();

      const stat1 = Array.from(stats1.values())[0];
      const stat2 = Array.from(stats2.values())[0];

      expect(stat2.timestamp).toBeGreaterThanOrEqual(stat1.timestamp);
    });
  });

  describe("Basic Statistics", () => {
    let pc1: RTCPeerConnection;
    let pc2: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
      await pc2.close();
    });

    describe("peer-connection statistics", () => {
      // デフォルトでpeer-connection統計が含まれることを確認
      test("contains peer-connection stats by default", async () => {
        const stats = await pc1.getStats();

        const pcStats = Array.from(stats.values()).find(
          (stat) => stat.type === "peer-connection",
        );

        expect(pcStats).toBeDefined();
        expect(pcStats?.id).toMatch(/^peer-connection/);
        expect(pcStats?.timestamp).toBeTypeOf("number");
        expect(pcStats?.timestamp).toBeGreaterThan(0);
      });

      // データチャンネル作成時にカウンター情報が含まれることを確認
      test("includes data channel counters", async () => {
        // Create multiple data channels
        const dc1 = pc1.createDataChannel("test-channel-1");
        const dc2 = pc1.createDataChannel("test-channel-2");

        const stats = await pc1.getStats();
        const pcStats = Array.from(stats.values()).find(
          (stat) => stat.type === "peer-connection",
        ) as RTCPeerConnectionStats | undefined;

        expect(pcStats).toBeDefined();
        expect(pcStats?.dataChannelsOpened).toBe(2);
        expect(pcStats?.dataChannelsClosed).toBe(0);
      });
    });

    describe("data-channel statistics", () => {
      // データチャンネル作成後にdata-channel統計が含まれることを確認
      test("includes data-channel stats after creating data channel", async () => {
        const dc1 = pc1.createDataChannel("test-channel", {
          maxRetransmits: 3,
        });

        const stats = await pc1.getStats();

        // Should contain data-channel stats
        const dataChannelStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "data-channel",
        );

        expect(dataChannelStats.length).toBeGreaterThan(0);

        const dcStat = dataChannelStats[0] as any;
        expect(dcStat.id).toMatch(/^data-channel/);
        expect(dcStat.label).toBe("test-channel");
        expect(dcStat.state).toBe("connecting");

        if (dcStat.dataChannelIdentifier !== undefined) {
          expect(dcStat.dataChannelIdentifier).toBeTypeOf("number");
        }
      });

      // 複数のデータチャンネルがそれぞれのラベルで追跡されることを確認
      test("tracks data channels with their labels", async () => {
        const dc1 = pc1.createDataChannel("channel-1");
        const dc2 = pc1.createDataChannel("channel-2");

        const stats = await pc1.getStats();
        const dataChannelStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "data-channel",
        );

        expect(dataChannelStats.length).toBe(2);

        const labels = dataChannelStats.map((stat: any) => stat.label);
        expect(labels.sort()).toEqual(["channel-1", "channel-2"]);
      });

      // データチャンネルのプロトコル情報と設定が統計に含まれることを確認
      test("includes protocol and configuration info", async () => {
        const dc1 = pc1.createDataChannel("test-channel", {
          protocol: "test-protocol",
          maxRetransmits: 5,
        });

        const stats = await pc1.getStats();
        const dataChannelStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "data-channel",
        );

        const dcStat = dataChannelStats[0] as any;
        expect(dcStat.protocol).toBe("test-protocol");
      });
    });

    describe("media-source statistics", () => {
      // オーディオトラックを追加時にmedia-source統計が含まれることを確認
      test("includes media-source stats for audio tracks", async () => {
        const track = new MediaStreamTrack({ kind: "audio" });
        pc1.addTrack(track);

        const stats = await pc1.getStats();
        const mediaSourceStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "media-source",
        );

        expect(mediaSourceStats.length).toBeGreaterThan(0);

        const audioStat = mediaSourceStats.find(
          (stat: any) => stat.kind === "audio",
        ) as any;
        expect(audioStat).toBeDefined();
        expect(audioStat.trackIdentifier).toBe(track.id);
        expect(audioStat.kind).toBe("audio");
        expect(audioStat.id).toMatch(/^media-source/);
      });

      // ビデオトラックを追加時にmedia-source統計が含まれることを確認
      test("includes media-source stats for video tracks", async () => {
        const track = new MediaStreamTrack({ kind: "video" });
        pc1.addTrack(track);

        const stats = await pc1.getStats();
        const mediaSourceStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "media-source",
        );

        expect(mediaSourceStats.length).toBeGreaterThan(0);

        const videoStat = mediaSourceStats.find(
          (stat: any) => stat.kind === "video",
        ) as any;
        expect(videoStat).toBeDefined();
        expect(videoStat.trackIdentifier).toBe(track.id);
        expect(videoStat.kind).toBe("video");
      });

      // 複数のメディアソースが個別に管理されることを確認
      test("tracks multiple media sources separately", async () => {
        const audioTrack = new MediaStreamTrack({ kind: "audio" });
        const videoTrack = new MediaStreamTrack({ kind: "video" });
        pc1.addTrack(audioTrack);
        pc1.addTrack(videoTrack);

        const stats = await pc1.getStats();
        const mediaSourceStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "media-source",
        );

        expect(mediaSourceStats.length).toBe(2);

        const kinds = mediaSourceStats.map((stat: any) => stat.kind);
        expect(kinds).toContain("audio");
        expect(kinds).toContain("video");
      });
    });

    describe("codec statistics", () => {
      // トランシーバーが存在する時にcodec統計が取得できることを確認
      test("handles codec stats when transceivers are present", async () => {
        const track = new MediaStreamTrack({ kind: "audio" });
        pc1.addTrack(track);
        await createDataChannelPair(undefined, pc1, pc2);

        const stats = await pc1.getStats();
        const codecStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "codec",
        );

        expect(codecStats.length).toBeGreaterThan(0);
        const codecStat = codecStats[0] as any;
        expect(codecStat.id).toMatch(/^codec/);
        expect(codecStat.payloadType).toBeTypeOf("number");
        expect(codecStat.mimeType).toBeTypeOf("string");
        expect(codecStat.transportId).toBeTypeOf("string");
      });

      // codec統計が利用可能時にコーデック詳細が正しく取得できることを確認
      test("validates codec details when available", async () => {
        const audioTrack = new MediaStreamTrack({ kind: "audio" });
        const videoTrack = new MediaStreamTrack({ kind: "video" });
        pc1.addTrack(audioTrack);
        pc1.addTrack(videoTrack);
        await createDataChannelPair(undefined, pc1, pc2);

        const stats = await pc1.getStats();
        const codecStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "codec",
        );

        expect(codecStats.length).toBeGreaterThan(0);
        for (const codecStat of codecStats) {
          const codec = codecStat as any;
          expect(codec.payloadType).toBeGreaterThanOrEqual(0);
          expect(codec.mimeType).toMatch(/^(audio|video)\//);
          if (codec.clockRate) {
            expect(codec.clockRate).toBeGreaterThan(0);
          }
        }
        expect(
          codecStats.some((codec: any) => codec.mimeType.startsWith("audio/")),
        ).toBe(true);
        expect(
          codecStats.some((codec: any) => codec.mimeType.startsWith("video/")),
        ).toBe(true);
      });
    });

    describe("outbound-rtp statistics", () => {
      // トラック追加時にoutbound-rtp統計が含まれることを確認
      test("includes outbound-rtp stats for added tracks", async () => {
        const track = new MediaStreamTrack({ kind: "audio" });
        pc1.addTrack(track);

        const stats = await pc1.getStats();
        const outboundStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "outbound-rtp",
        );

        expect(outboundStats.length).toBeGreaterThan(0);

        const outboundStat = outboundStats[0] as any;
        expect(outboundStat.id).toMatch(/^outbound-rtp/);
        expect(outboundStat.ssrc).toBeTypeOf("number");
        expect(outboundStat.kind).toBeTypeOf("string");

        // mediaSourceId might be undefined in some implementations or timing conditions
        if (outboundStat.mediaSourceId !== undefined) {
          expect(outboundStat.mediaSourceId).toBeTypeOf("string");
        }
      });

      // 異なるトラックが個別に管理されることを確認
      test("tracks different tracks separately", async () => {
        const audioTrack = new MediaStreamTrack({ kind: "audio" });
        const videoTrack = new MediaStreamTrack({ kind: "video" });
        pc1.addTrack(audioTrack);
        pc1.addTrack(videoTrack);

        const stats = await pc1.getStats();
        const outboundStats = Array.from(stats.values()).filter(
          (stat) => stat.type === "outbound-rtp",
        );

        expect(outboundStats.length).toBe(2);

        const kinds = outboundStats.map((stat: any) => stat.kind);
        expect(kinds).toContain("audio");
        expect(kinds).toContain("video");
      });
    });
  });

  describe("Selector Functionality", () => {
    let pc1: RTCPeerConnection;
    let pc2: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
      await pc2.close();
    });

    // トラックセレクターで結果が正しくフィルタリングされることを確認
    test("getStats() with track selector filters results correctly", async () => {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      const videoTrack = new MediaStreamTrack({ kind: "video" });

      pc1.addTrack(audioTrack);
      pc1.addTrack(videoTrack);

      // Get stats with audio track selector
      const audioStats = await pc1.getStats(audioTrack);
      const videoStats = await pc1.getStats(videoTrack);
      const allStats = await pc1.getStats();

      // Audio stats should only contain audio-related statistics
      const audioOutboundStats = Array.from(audioStats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );
      for (const stat of audioOutboundStats) {
        expect((stat as any).kind).toBe("audio");
      }

      // Video stats should only contain video-related statistics
      const videoOutboundStats = Array.from(videoStats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );
      for (const stat of videoOutboundStats) {
        expect((stat as any).kind).toBe("video");
      }

      // All stats should contain both
      const allOutboundStats = Array.from(allStats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );
      expect(allOutboundStats.length).toBe(2);
    });

    // セレクターでmedia-source統計が正しくフィルタリングされることを確認
    test("selector filters media-source stats correctly", async () => {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      const videoTrack = new MediaStreamTrack({ kind: "video" });

      pc1.addTrack(audioTrack);
      pc1.addTrack(videoTrack);

      const audioStats = await pc1.getStats(audioTrack);
      const audioMediaSourceStats = Array.from(audioStats.values()).filter(
        (stat) => stat.type === "media-source",
      );

      // Should only contain audio media source
      expect(audioMediaSourceStats.length).toBe(1);
      expect((audioMediaSourceStats[0] as any).trackIdentifier).toBe(
        audioTrack.id,
      );
      expect((audioMediaSourceStats[0] as any).kind).toBe("audio");
    });

    // セレクターで関係のない統計が除外されることを確認
    test("selector excludes unrelated statistics", async () => {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      const videoTrack = new MediaStreamTrack({ kind: "video" });

      pc1.addTrack(audioTrack);
      pc1.addTrack(videoTrack);

      const audioStats = await pc1.getStats(audioTrack);

      // Should not contain video-related outbound-rtp stats
      const outboundStats = Array.from(audioStats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );

      const videoOutboundStats = outboundStats.filter(
        (stat: any) => stat.kind === "video",
      );
      expect(videoOutboundStats.length).toBe(0);
    });

    // セレクター結果が peer-wide/data-channel を混ぜず、参照 closure を含むことを確認
    test("selector only returns the selected stats graph closure", async () => {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      pc1.createDataChannel("unrelated-data-channel");
      pc1.addTrack(audioTrack);
      await createDataChannelPair(undefined, pc1, pc2);

      // Act: selector 付きで audio sender の stats graph を取得する。
      const audioStats = await pc1.getStats(audioTrack);

      // Assert: peer-wide / data-channel を含めず、参照先 transport は closure に含む。
      expect(
        Array.from(audioStats.values()).some(
          (stat) => stat.type === "peer-connection",
        ),
      ).toBe(false);
      expect(
        Array.from(audioStats.values()).some(
          (stat) => stat.type === "data-channel",
        ),
      ).toBe(false);

      const outbound = Array.from(audioStats.values()).find(
        (stat) => stat.type === "outbound-rtp",
      ) as any;
      expect(outbound).toBeDefined();
      if (outbound.transportId) {
        expect(audioStats.has(outbound.transportId)).toBe(true);
      }
      if (outbound.codecId) {
        expect(audioStats.has(outbound.codecId)).toBe(true);
      }
      if (outbound.mediaSourceId) {
        expect(audioStats.has(outbound.mediaSourceId)).toBe(true);
      }

      const transport = outbound.transportId
        ? audioStats.get(outbound.transportId)
        : undefined;
      if ((transport as any)?.selectedCandidatePairId) {
        expect(audioStats.has((transport as any).selectedCandidatePairId)).toBe(
          true,
        );
        const pair = audioStats.get(
          (transport as any).selectedCandidatePairId,
        ) as any;
        expect(audioStats.has(pair.localCandidateId)).toBe(true);
        expect(audioStats.has(pair.remoteCandidateId)).toBe(true);
      }
    });

    // selector 付きの report が sender/receiver API と同じく RTCStatsReport であることを確認
    test("sender and receiver getStats return RTCStatsReport", async () => {
      const audioTrack = new MediaStreamTrack({ kind: "audio" });
      const sender = pc1.addTrack(audioTrack);
      await createDataChannelPair(undefined, pc1, pc2);

      // Act: sender/receiver の公開 API から stats を取得する。
      const senderStats = await sender.getStats();
      const receiver = pc2
        .getReceivers()
        .find((candidate) => candidate.kind === "audio");
      const receiverStats = receiver ? await receiver.getStats() : undefined;

      // Assert: どちらも W3C 互換の RTCStatsReport を返す。
      expect(senderStats).toBeInstanceOf(RTCStatsReport);
      expect(receiverStats).toBeInstanceOf(RTCStatsReport);
    });

    test("sender and receiver codec stats use distinct ids on the same transport", async () => {
      const localAudioTrack = new MediaStreamTrack({ kind: "audio" });
      const remoteAudioTrack = new MediaStreamTrack({ kind: "audio" });
      pc1.addTrack(localAudioTrack);
      pc2.addTrack(remoteAudioTrack);
      await createDataChannelPair(undefined, pc1, pc2);

      // Act: full-duplex audio 接続の stats を取得する。
      const stats = await pc1.getStats();

      // Assert: inbound/outbound が同一 payload type でも codecId は衝突しない。
      const outbound = Array.from(stats.values()).find(
        (stat) =>
          stat.type === "outbound-rtp" && (stat as any).kind === "audio",
      ) as any;
      const inbound = Array.from(stats.values()).find(
        (stat) => stat.type === "inbound-rtp" && (stat as any).kind === "audio",
      ) as any;
      expect(outbound?.codecId).toBeDefined();
      expect(inbound?.codecId).toBeDefined();
      expect(outbound.codecId).not.toBe(inbound.codecId);
      expect(stats.has(outbound.codecId)).toBe(true);
      expect(stats.has(inbound.codecId)).toBe(true);
    });
  });

  describe("Error Cases", () => {
    let pc1: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
    });

    // 存在しないトラックでgetStats()を呼び出してもエラーにならないことを確認
    test("getStats() with non-existent track returns empty filtered results", async () => {
      const nonExistentTrack = new MediaStreamTrack({ kind: "audio" });

      const stats = await pc1.getStats(nonExistentTrack);

      // Should return an empty report because no monitored object matches selector
      expect(stats).toBeInstanceOf(RTCStatsReport);
      expect(stats.size).toBe(0);
    });

    // トラック削除後の lifetime を固定し、selector からは外れることを確認
    test("getStats() keeps sender stats but drops selector roots after track removal", async () => {
      const track = new MediaStreamTrack({ kind: "audio" });
      const sender = pc1.addTrack(track);

      // Verify track is added
      let stats = await pc1.getStats();
      let outboundStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );
      expect(outboundStats.length).toBeGreaterThan(0);

      // Act: sender を removeTrack して peer-wide stats を取り直す。
      pc1.removeTrack(sender);
      stats = await pc1.getStats();
      outboundStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "outbound-rtp",
      );
      const selectorStats = await pc1.getStats(track);

      // Assert: sender object 由来の outbound は残り、selector root は消える。
      expect(stats).toBeInstanceOf(RTCStatsReport);
      expect(outboundStats.length).toBeGreaterThan(0);
      expect(
        Array.from(stats.values()).some((stat) => stat.type === "media-source"),
      ).toBe(false);
      expect(selectorStats.size).toBe(0);
    });

    // close 後の lifetime を固定し、transport state が closed に止まることを確認
    test("getStats() preserves report shape after close with closed transport states", async () => {
      const remote = new RTCPeerConnection();
      await createDataChannelPair(undefined, pc1, remote);
      await pc1.close();

      // Act: close 後の report を取得する。
      const stats = await pc1.getStats();
      await remote.close();

      // Assert: peer-connection は残り、transport は closed に遷移済み。
      expect(stats).toBeInstanceOf(RTCStatsReport);
      expect(
        Array.from(stats.values()).some(
          (stat) => stat.type === "peer-connection",
        ),
      ).toBe(true);
      const transportStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "transport",
      ) as any[];
      expect(transportStats.length).toBeGreaterThan(0);
      for (const transportStat of transportStats) {
        expect(transportStat.dtlsState).toBe("closed");
        expect(transportStat.iceState).toBe("closed");
      }
    });

    // 無効なセレクターでもgetStats()がグレースフルに処理されることを確認
    test("getStats() handles invalid selector gracefully", async () => {
      // Test with invalid selector types
      const stats1 = await pc1.getStats(undefined as any);
      const stats2 = await pc1.getStats({} as any);

      expect(stats1).toBeInstanceOf(RTCStatsReport);
      expect(stats2).toBeInstanceOf(RTCStatsReport);
    });
  });

  describe("Connection Statistics", () => {
    let pc1: RTCPeerConnection;
    let pc2: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
      pc2 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
      await pc2.close();
    });

    // 新しい接続では基本統計のみが含まれることを確認
    test("empty stats for new connection", async () => {
      const stats = await pc1.getStats();

      // Should only contain peer-connection stats for new connection
      const statTypes = Array.from(stats.values()).map((stat) => stat.type);
      expect(statTypes).toContain("peer-connection");

      // Should not contain transport stats yet (no connection established)
      expect(statTypes).not.toContain("transport");
      expect(statTypes).not.toContain("candidate-pair");
    });

    // WebRTC接続確立後にtransport統計が含まれることを確認
    test("includes transport stats after connection establishment", async () => {
      await createDataChannelPair(undefined, pc1, pc2);

      const stats = await pc1.getStats();
      const transportStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "transport",
      );

      expect(transportStats.length).toBeGreaterThan(0);
      const transportStat = transportStats[0] as any;
      expect(transportStat.id).toMatch(/^transport/);
      expect(transportStat.dtlsState).toBeDefined();
    });

    // ICE候補統計が接続時に含まれることを確認
    test("includes ICE candidate stats after connection", async () => {
      await createDataChannelPair(undefined, pc1, pc2);

      const stats = await pc1.getStats();
      const localCandidateStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "local-candidate",
      );
      const remoteCandidateStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "remote-candidate",
      );

      expect(localCandidateStats.length).toBeGreaterThan(0);
      expect(remoteCandidateStats.length).toBeGreaterThan(0);
      const candidateStat = localCandidateStats[0] as any;
      expect(candidateStat.id).toMatch(/^local-candidate/);
      expect(candidateStat.candidateType).toBeDefined();
    });

    // candidate-pair統計が必要なプロパティを持つことを確認
    test("candidate pair stats include required properties", async () => {
      await createDataChannelPair(undefined, pc1, pc2);

      const stats = await pc1.getStats();
      const candidatePairStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "candidate-pair",
      );

      expect(candidatePairStats.length).toBeGreaterThan(0);
      const pairStat = candidatePairStats[0] as any;
      expect(pairStat.id).toMatch(/^candidate-pair/);
      expect(pairStat.localCandidateId).toBeDefined();
      expect(pairStat.remoteCandidateId).toBeDefined();
      expect(pairStat.state).toMatch(
        /^(frozen|waiting|in-progress|failed|succeeded)$/,
      );
    });

    // 接続後に証明書統計が含まれることを確認
    test("includes certificate stats after connection", async () => {
      await createDataChannelPair(undefined, pc1, pc2);

      const stats = await pc1.getStats();
      const certificateStats = Array.from(stats.values()).filter(
        (stat) => stat.type === "certificate",
      );

      expect(certificateStats.length).toBeGreaterThan(0);
      for (const certStat of certificateStats as any[]) {
        expect(certStat.id).toMatch(/^certificate/);
        expect(certStat.fingerprint).toBeDefined();
        expect(certStat.fingerprintAlgorithm).toBeDefined();
        expect(certStat.base64Certificate).toBeTruthy();
      }
    });
  });

  describe("Performance & Validation", () => {
    let pc1: RTCPeerConnection;

    beforeEach(() => {
      pc1 = new RTCPeerConnection();
    });

    afterEach(async () => {
      await pc1.close();
    });

    // getStats()のパフォーマンスが合理的な範囲内であることを確認
    test("getStats() performance is reasonable", async () => {
      // Add multiple tracks to increase stats complexity
      for (let i = 0; i < 5; i++) {
        pc1.addTrack(new MediaStreamTrack({ kind: "audio" }));
        pc1.addTrack(new MediaStreamTrack({ kind: "video" }));
        pc1.createDataChannel(`channel-${i}`);
      }

      const startTime = performance.now();
      const stats = await pc1.getStats();
      const endTime = performance.now();

      const duration = endTime - startTime;

      // Should complete within reasonable time (adjusted for realistic performance)
      expect(duration).toBeLessThan(500); // 500ms max - more realistic threshold
      expect(stats.size).toBeGreaterThan(0);
    });

    // タイムスタンプが単調増加することを確認
    test("timestamps are monotonically increasing", async () => {
      pc1.addTrack(new MediaStreamTrack({ kind: "audio" }));

      const stats1 = await pc1.getStats();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stats2 = await pc1.getStats();

      // All timestamps in stats2 should be >= corresponding stats in stats1
      for (const [id, stat2] of stats2) {
        const stat1 = stats1.get(id);
        if (stat1) {
          expect(stat2.timestamp).toBeGreaterThanOrEqual(stat1.timestamp);
        }
      }
    });

    // 統計IDがgetStats()呼び出し間で一貫していることを確認
    test("stat IDs remain consistent across calls", async () => {
      pc1.addTrack(new MediaStreamTrack({ kind: "audio" }));
      pc1.createDataChannel("test");

      const stats1 = await pc1.getStats();
      const stats2 = await pc1.getStats();

      // Should have same IDs (for stable components)
      const ids1 = Array.from(stats1.keys()).sort();
      const ids2 = Array.from(stats2.keys()).sort();

      expect(ids1).toEqual(ids2);
    });

    // 数値統計値が合理的な範囲内であることを確認
    test("validates numeric stat values are reasonable", async () => {
      pc1.addTrack(new MediaStreamTrack({ kind: "audio" }));

      const stats = await pc1.getStats();

      for (const [id, stat] of stats) {
        // Timestamps should be positive and reasonable
        expect(stat.timestamp).toBeGreaterThan(0);
        expect(stat.timestamp).toBeLessThan(Date.now() + 1000); // Not in far future

        // Check numeric properties in stats
        if (stat.type === "outbound-rtp") {
          const rtpStat = stat as any;
          if (typeof rtpStat.ssrc === "number") {
            expect(rtpStat.ssrc).toBeGreaterThan(0);
          }
          if (typeof rtpStat.packetsSent === "number") {
            expect(rtpStat.packetsSent).toBeGreaterThanOrEqual(0);
          }
          if (typeof rtpStat.bytesSent === "number") {
            expect(rtpStat.bytesSent).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });
  });
});
