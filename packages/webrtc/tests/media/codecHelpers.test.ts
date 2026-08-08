import {
  useAV1,
  useAV1X,
  useG722,
  useH264,
  usePCMA,
  usePCMU,
  useVP8,
  useVP9,
  supportedCodecs,
} from "../../src/media/codec";
import {
  defaultPeerConfig,
  findCodecByMimeType,
} from "../../src/peerConnection";

// RFC 3551 Table 4 — static payload types and clock rates for G.711 / G.722

describe("packages/webrtc/tests/media/codecHelpers.test.ts", () => {
  it("usePCMU static PT 0 / 8000 Hz", () => {
    // Arrange / Act
    const codec = usePCMU();
    // Assert: RFC 3551
    expect(codec.mimeType.toLowerCase()).toBe("audio/pcmu");
    expect(codec.clockRate).toBe(8000);
    expect(codec.payloadType).toBe(0);
    expect(codec.channels).toBe(1);
  });

  it("usePCMA static PT 8 / 8000 Hz", () => {
    // Arrange / Act
    const codec = usePCMA();
    // Assert
    expect(codec.mimeType.toLowerCase()).toBe("audio/pcma");
    expect(codec.clockRate).toBe(8000);
    expect(codec.payloadType).toBe(8);
    expect(codec.channels).toBe(1);
  });

  it("useG722 static PT 9 / RTP clock 8000 Hz", () => {
    // Arrange / Act
    const codec = useG722();
    // Assert: clock is 8000 even though codec samples at 16 kHz (RFC 3551 §4.5.2)
    expect(codec.mimeType.toLowerCase()).toBe("audio/g722");
    expect(codec.clockRate).toBe(8000);
    expect(codec.payloadType).toBe(9);
    expect(codec.channels).toBe(1);
  });

  it("allows overriding payloadType via props", () => {
    // Arrange / Act
    const pcma = usePCMA({ payloadType: 96 });
    const g722 = useG722({ payloadType: 97 });
    // Assert
    expect(pcma.payloadType).toBe(96);
    expect(g722.payloadType).toBe(97);
    // clock rates remain static defaults
    expect(pcma.clockRate).toBe(8000);
    expect(g722.clockRate).toBe(8000);
  });

  it("useAV1 uses standard video/AV1 SDP name", () => {
    // Arrange / Act
    const av1 = useAV1();
    // Assert: AV1 RTP payload format SDP mapping
    expect(av1.mimeType.toLowerCase()).toBe("video/av1");
    expect(av1.clockRate).toBe(90000);
  });

  it("useAV1X remains available as legacy alias mime", () => {
    // Arrange / Act
    const av1x = useAV1X();
    // Assert
    expect(av1x.mimeType.toLowerCase()).toBe("video/av1x");
    expect(av1x.clockRate).toBe(90000);
  });

  it("findCodecByMimeType treats AV1 and AV1X as the same codec", () => {
    // Arrange: local advertises only standard AV1
    const local = [useAV1({ payloadType: 96 })];
    const remoteAv1x = useAV1X({ payloadType: 45 });
    const remoteAv1 = useAV1({ payloadType: 45 });
    const remoteVp8 = useVP8({ payloadType: 96 });

    // Act / Assert: AV1X remote matches local AV1
    expect(findCodecByMimeType(local, remoteAv1x)).toBe(remoteAv1x);
    expect(findCodecByMimeType(local, remoteAv1)).toBe(remoteAv1);
    // 逆方向: local が AV1X のみでも remote AV1 とマッチ
    expect(findCodecByMimeType([useAV1X()], remoteAv1)).toBe(remoteAv1);
    // 無関係 codec はマッチしない
    expect(findCodecByMimeType(local, remoteVp8)).toBeUndefined();
  });

  it("supportedCodecs lists AV1 before AV1X", () => {
    // Arrange / Act
    const lower = supportedCodecs.map((m) => m.toLowerCase());
    // Assert
    expect(lower).toContain("video/av1");
    expect(lower).toContain("video/av1x");
    expect(lower.indexOf("video/av1")).toBeLessThan(lower.indexOf("video/av1x"));
  });

  it("defaultPeerConfig advertises AV1 (and common video codecs)", () => {
    // Arrange / Act
    const mimes = defaultPeerConfig.codecs.video.map((c) =>
      c.mimeType.toLowerCase(),
    );
    // Assert: もはや VP8 のみではなく AV1 を含む（AV1X は legacy として後段）
    expect(mimes).toContain("video/av1");
    expect(mimes).toContain("video/av1x");
    expect(mimes).toContain("video/vp8");
    expect(mimes).toContain("video/vp9");
    expect(mimes).toContain("video/h264");
    expect(mimes.length).toBeGreaterThan(1);
    expect(mimes.indexOf("video/av1")).toBeLessThan(mimes.indexOf("video/av1x"));
    // 既定 audio は維持
    expect(
      defaultPeerConfig.codecs.audio.map((c) => c.mimeType.toLowerCase()),
    ).toEqual(expect.arrayContaining(["audio/opus", "audio/pcmu"]));
  });
});
