/**
 * Example: RTCPeerConnection.getStats() usage demonstration
 *
 * This example shows how to use the getStats() method to collect
 * WebRTC statistics from a data channel connection.
 */

import { MediaStreamTrack, RTCPeerConnection } from "../../packages/webrtc/src";

async function demonstrateGetStats() {
  console.log("=== RTCPeerConnection.getStats() Demo ===\n");

  // Create peer connections
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();

  try {
    // 1. Basic getStats() call on new connection
    console.log("1. Basic getStats() on new connection:");
    const initialStats = await pc1.getStats();
    console.log(`   Number of stats objects: ${initialStats.size}`);

    for (const [id, stat] of initialStats) {
      console.log(`   - ${stat.type}: ${id}`);
    }
    console.log();

    // 2. Create data channel and check stats
    console.log("2. After creating data channel:");
    const dataChannel = pc1.createDataChannel("demo", {
      maxRetransmits: 3,
    });

    const dcStats = await pc1.getStats();
    console.log(`   Number of stats objects: ${dcStats.size}`);

    const pcStat = Array.from(dcStats.values()).find(
      (s) => s.type === "peer-connection",
    ) as any;
    if (pcStat) {
      console.log(`   Data channels opened: ${pcStat.dataChannelsOpened || 0}`);
      console.log(`   Data channels closed: ${pcStat.dataChannelsClosed || 0}`);
    }
    console.log();

    // 3. Add media track and check stats
    console.log("3. After adding media track:");
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    pc1.addTrack(audioTrack);

    const mediaStats = await pc1.getStats();
    console.log(`   Number of stats objects: ${mediaStats.size}`);

    // Check for media-source stats
    const mediaSourceStats = Array.from(mediaStats.values()).filter(
      (s) => s.type === "media-source",
    );
    console.log(`   Media source stats found: ${mediaSourceStats.length}`);

    if (mediaSourceStats.length > 0) {
      const mediaStat = mediaSourceStats[0] as any;
      console.log(`   - Track ID: ${mediaStat.trackIdentifier}`);
      console.log(`   - Kind: ${mediaStat.kind}`);
    }
    console.log();

    // 4. Track selector filtering
    console.log("4. getStats() with track selector:");
    const trackStats = await pc1.getStats(audioTrack);
    console.log(`   Stats for audio track: ${trackStats.size} objects`);

    for (const [id, stat] of trackStats) {
      console.log(`   - ${stat.type}: ${id}`);
    }
    console.log();

    // 5. Stats properties inspection
    console.log("5. Detailed stats inspection:");
    const detailedStats = await pc1.getStats();

    for (const [id, stat] of detailedStats) {
      console.log(`   ${stat.type} (${id}):`);
      console.log(`     timestamp: ${stat.timestamp}`);

      // Show type-specific properties
      if (stat.type === "peer-connection") {
        const pcStat = stat as any;
        console.log(
          `     dataChannelsOpened: ${pcStat.dataChannelsOpened || 0}`,
        );
        console.log(
          `     dataChannelsClosed: ${pcStat.dataChannelsClosed || 0}`,
        );
      } else if (stat.type === "media-source") {
        const mediaStat = stat as any;
        console.log(`     trackIdentifier: ${mediaStat.trackIdentifier}`);
        console.log(`     kind: ${mediaStat.kind}`);
      }
      console.log();
    }

    // 6. Stats timing
    console.log("6. Stats timing consistency:");
    const stats1 = await pc1.getStats();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stats2 = await pc1.getStats();

    const timestamp1 = Array.from(stats1.values())[0].timestamp;
    const timestamp2 = Array.from(stats2.values())[0].timestamp;

    console.log(`   First call timestamp: ${timestamp1}`);
    console.log(`   Second call timestamp: ${timestamp2}`);
    console.log(
      `   Time difference: ${(timestamp2 - timestamp1).toFixed(2)}ms`,
    );
    console.log();

    console.log("✅ getStats() demonstration completed successfully!");
  } catch (error) {
    console.error("❌ Error during getStats() demonstration:", error);
  } finally {
    // Clean up
    await pc1.close();
    await pc2.close();
  }
}

// Run the demonstration
if (require.main === module) {
  demonstrateGetStats().catch(console.error);
}

export { demonstrateGetStats };
