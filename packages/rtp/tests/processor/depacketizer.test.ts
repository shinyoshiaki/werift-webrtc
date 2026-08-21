import { RtpHeader, RtpPacket } from "../../src";
import { DepacketizeBase } from "../../src/extra/processor/depacketizer";

describe("DepacketizeBase padding-only", () => {
  test("padding-only in the middle of a frame does not discard the buffer", () => {
    // Arrange: VP8 フレーム組み立て中（marker 待ち）
    const depacketizer = new DepacketizeBase("VP8", {
      isFinalPacketInSequence: (header) => header.marker,
    });
    const first = new RtpPacket(
      new RtpHeader({ sequenceNumber: 1, timestamp: 90, marker: false }),
      Buffer.from([0x00, 0xaa]),
    );
    const padding = new RtpPacket(
      new RtpHeader({
        sequenceNumber: 2,
        timestamp: 90,
        marker: false,
        padding: true,
        paddingSize: 8,
      }),
      Buffer.alloc(0),
    );
    const last = new RtpPacket(
      new RtpHeader({ sequenceNumber: 3, timestamp: 90, marker: true }),
      Buffer.from([0x00, 0xbb]),
    );

    // Act: メディア → probe padding → 終端メディア
    expect(depacketizer.processInput({ rtp: first, time: 0 })).toEqual([]);
    expect(depacketizer.processInput({ rtp: padding, time: 1 })).toEqual([]);
    const output = depacketizer.processInput({ rtp: last, time: 2 });

    // Assert: padding で clearBuffer されず、両メディアが 1 フレームになる
    expect(output).toHaveLength(1);
    expect(output[0].frame?.data).toEqual(Buffer.from([0xaa, 0xbb]));
  });
});
