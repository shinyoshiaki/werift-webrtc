import {
  RTP_EXTENSION_URI,
  rtpHeaderExtensionsParser,
} from "../../src/rtp/headerExtension";

describe("rtp header extension short payload", () => {
  test("truncated TWCC / abs-send-time / audio-level / orientation are ignored", () => {
    // Arrange: 各拡張の最小長未満
    const extensions = [
      { id: 1, payload: Buffer.alloc(1) },
      { id: 2, payload: Buffer.alloc(2) },
      { id: 3, payload: Buffer.alloc(0) },
      { id: 4, payload: Buffer.alloc(0) },
      { id: 5, payload: Buffer.from("mid") },
    ];
    const map = {
      1: RTP_EXTENSION_URI.transportWideCC,
      2: RTP_EXTENSION_URI.absSendTime,
      3: RTP_EXTENSION_URI.audioLevelIndication,
      4: RTP_EXTENSION_URI.videoOrientation,
      5: RTP_EXTENSION_URI.sdesMid,
    };

    // Act: 短すぎる拡張を含むパース
    const parsed = rtpHeaderExtensionsParser(extensions, map);

    // Assert: 壊れた拡張は落ちずスキップし、有効な mid は残る
    expect(parsed[RTP_EXTENSION_URI.transportWideCC]).toBeUndefined();
    expect(parsed[RTP_EXTENSION_URI.absSendTime]).toBeUndefined();
    expect(parsed[RTP_EXTENSION_URI.audioLevelIndication]).toBeUndefined();
    expect(parsed[RTP_EXTENSION_URI.videoOrientation]).toBeUndefined();
    expect(parsed[RTP_EXTENSION_URI.sdesMid]).toBe("mid");
  });
});
