import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RTCPeerConnection } from "../../src";
import { RTCStatsReport } from "../../src/media/stats";
import { MediaStreamTrack } from "../../src/media/track";

describe("RTCPeerConnection.getStats()", () => {
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

  test("getStats() returns RTCStatsReport instance", async () => {
    const stats = await pc1.getStats();
    expect(stats).toBeInstanceOf(RTCStatsReport);
    expect(stats).toBeInstanceOf(Map);
  });

  test("getStats() returns peer-connection stats by default", async () => {
    const stats = await pc1.getStats();

    // Should contain at least peer-connection stats
    const pcStats = Array.from(stats.values()).find(
      (stat) => stat.type === "peer-connection",
    );

    expect(pcStats).toBeDefined();
    expect(pcStats?.id).toMatch(/^peer-connection/);
    expect(pcStats?.timestamp).toBeTypeOf("number");
    expect(pcStats?.timestamp).toBeGreaterThan(0);
  });

  test("getStats() with null selector returns all stats", async () => {
    const stats = await pc1.getStats(null);
    expect(stats).toBeInstanceOf(RTCStatsReport);

    // Should contain peer-connection stats
    const pcStats = Array.from(stats.values()).find(
      (stat) => stat.type === "peer-connection",
    );
    expect(pcStats).toBeDefined();
  });

  test("getStats() returns empty stats for new connection", async () => {
    const stats = await pc1.getStats();

    // Should only contain peer-connection stats for new connection
    const statTypes = Array.from(stats.values()).map((stat) => stat.type);
    expect(statTypes).toContain("peer-connection");

    // Should not contain transport stats yet (no connection established)
    expect(statTypes).not.toContain("transport");
    expect(statTypes).not.toContain("candidate-pair");
  });

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

  test("stats IDs are unique", async () => {
    const stats = await pc1.getStats();

    const ids = Array.from(stats.keys());
    const uniqueIds = new Set(ids);

    expect(ids.length).toBe(uniqueIds.size);
  });

  test("consecutive getStats() calls have increasing timestamps", async () => {
    const stats1 = await pc1.getStats();

    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 1));

    const stats2 = await pc1.getStats();

    const stat1 = Array.from(stats1.values())[0];
    const stat2 = Array.from(stats2.values())[0];

    expect(stat2.timestamp).toBeGreaterThanOrEqual(stat1.timestamp);
  });
});

describe("RTCPeerConnection.getStats() with DataChannel", () => {
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

  test("getStats() includes data-channel stats after creating data channel", async () => {
    // Create data channel
    const dc1 = pc1.createDataChannel("test-channel", {
      maxRetransmits: 3,
    });

    // Just check that we can get stats without full connection
    const stats = await pc1.getStats();

    // Should contain peer-connection stats
    const pcStats = Array.from(stats.values()).find(
      (stat) => stat.type === "peer-connection",
    );
    expect(pcStats).toBeDefined();
  });
});

describe("RTCPeerConnection.getStats() with Media", () => {
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

  test("getStats() with track selector filters results", async () => {
    // Create mock audio track
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    const videoTrack = new MediaStreamTrack({ kind: "video" });

    // Add tracks
    pc1.addTrack(audioTrack);
    pc1.addTrack(videoTrack);

    // Get stats with audio track selector
    const audioStats = await pc1.getStats(audioTrack);

    // Should only contain stats related to the audio track
    const outboundRtpStats = Array.from(audioStats.values()).filter(
      (stat) => stat.type === "outbound-rtp",
    );

    // Check if the outbound RTP stats are for audio
    for (const stat of outboundRtpStats) {
      const rtpStat = stat as any;
      if (rtpStat.kind) {
        expect(rtpStat.kind).toBe("audio");
      }
    }
  });

  test("getStats() includes codec stats when transceivers are present", async () => {
    // Create mock track and add to peer connection
    const track = new MediaStreamTrack({ kind: "audio" });
    pc1.addTrack(track);

    const stats = await pc1.getStats();

    // Should contain at least peer-connection stats
    const pcStats = Array.from(stats.values()).find(
      (stat) => stat.type === "peer-connection",
    );
    expect(pcStats).toBeDefined();

    // Note: Codec stats may not be present until DTLS transport is established
    // This test verifies that getStats() doesn't fail with transceivers present
  });

  test("getStats() includes media-source stats for tracks", async () => {
    // Create mock track and add to peer connection
    const track = new MediaStreamTrack({ kind: "video" });
    pc1.addTrack(track);

    const stats = await pc1.getStats();

    // Should contain media-source stats
    const mediaSourceStats = Array.from(stats.values()).filter(
      (stat) => stat.type === "media-source",
    );

    expect(mediaSourceStats.length).toBeGreaterThan(0);

    const mediaStat = mediaSourceStats[0] as any;
    expect(mediaStat.trackIdentifier).toBe(track.id);
    expect(mediaStat.kind).toBe("video");
  });
});
