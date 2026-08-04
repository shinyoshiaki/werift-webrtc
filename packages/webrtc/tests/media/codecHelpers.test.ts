import { useG722, usePCMA, usePCMU } from "../../src/media/codec";

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
});
