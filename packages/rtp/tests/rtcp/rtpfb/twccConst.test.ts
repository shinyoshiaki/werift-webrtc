import { PacketChunk, PacketStatus } from "../../../src";

describe("packages/rtp/tests/rtcp/rtpfb/twccConst.test.ts", () => {
  test("PacketChunk and PacketStatus keep their values", () => {
    // Act / Assert: const オブジェクト化しても公開値は変わっていない
    expect(PacketChunk.TypeTCCRunLengthChunk).toBe(0);
    expect(PacketChunk.TypeTCCStatusVectorChunk).toBe(1);
    expect(PacketChunk.packetStatusChunkLength).toBe(2);
    expect(PacketStatus.TypeTCCPacketNotReceived).toBe(0);
    expect(PacketStatus.TypeTCCPacketReceivedSmallDelta).toBe(1);
    expect(PacketStatus.TypeTCCPacketReceivedLargeDelta).toBe(2);
    expect(PacketStatus.TypeTCCPacketReceivedWithoutDelta).toBe(3);
  });
});
