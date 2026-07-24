import { RtpHeader, RtpPacket } from "../../src/rtp/rtp";
import { unwrapRtx, wrapRtx } from "../../src/rtp/rtx";

describe("rtp/rtx", () => {
  test("wrap/unwrap preserves sequence number including wrap boundary", () => {
    // Arrange: sequence number が 16 bit 境界の 65535
    const original = new RtpPacket(
      new RtpHeader({
        payloadType: 96,
        marker: true,
        sequenceNumber: 65535,
        timestamp: 1234,
        ssrc: 0x11223344,
      }),
      Buffer.from([1, 2, 3]),
    );

    // Act: RTX に包んでから元の RTP に戻す
    const rtx = wrapRtx(original, 97, 1, 0x55667788);
    const restored = unwrapRtx(rtx, 96, 0x11223344);

    // Assert: 元の sequence number / payload が保持されること
    expect(rtx.payload.readUInt16BE(0)).toBe(65535);
    expect(restored.header.sequenceNumber).toBe(65535);
    expect(restored.payload.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(restored.header.ssrc).toBe(0x11223344);
    expect(restored.header.payloadType).toBe(96);
  });
});
