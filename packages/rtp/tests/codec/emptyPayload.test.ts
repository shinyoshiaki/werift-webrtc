import {
  AV1RtpPayload,
  H264RtpPayload,
  Vp8RtpPayload,
  Vp9RtpPayload,
} from "../../src";

describe("codec empty / truncated RTP payload", () => {
  test.each([
    ["VP8", (buf: Buffer) => Vp8RtpPayload.deSerialize(buf)],
    ["VP9", (buf: Buffer) => Vp9RtpPayload.deSerialize(buf)],
    ["H264", (buf: Buffer) => H264RtpPayload.deSerialize(buf)],
    ["AV1", (buf: Buffer) => AV1RtpPayload.deSerialize(buf)],
  ] as const)(
    "%s empty payload throws a dedicated error, not TypeError",
    (codec, parse) => {
      // Arrange: 空のメディア payload（probe を誤って渡した場合）
      const empty = Buffer.alloc(0);

      // Act / Assert: getBit(undefined) の TypeError ではなく明示的な失敗
      expect(() => parse(empty)).toThrow(new RegExp(`${codec}|truncated`, "i"));
      try {
        parse(empty);
      } catch (error) {
        expect(error).not.toBeInstanceOf(TypeError);
      }
    },
  );

  test("VP8 X-bit set with only 1 byte is truncated", () => {
    // Arrange: 必須の X オクテットが欠けている
    const buf = Buffer.from([0x80]);

    // Act / Assert
    expect(() => Vp8RtpPayload.deSerialize(buf)).toThrow(/truncated/i);
  });

  test("H264 FU-A with only the indicator octet is truncated", () => {
    // Arrange: FU-A (type 28) は FU header が必要
    const buf = Buffer.from([28]);

    // Act / Assert
    expect(() => H264RtpPayload.deSerialize(buf)).toThrow(/truncated/i);
  });
});
