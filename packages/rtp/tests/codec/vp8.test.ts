import {
  Vp8Packetizer,
  Vp8RtpPayload,
  dePacketizeRtpPackets,
} from "../../src";

// RFC 7741 §4.2 descriptor (X=0 minimal), §4.3 payload header P bit (keyframe)

/** Minimal VP8 frame: P=0 (key) in first byte of payload header. */
function makeVp8Keyframe(bodyLen = 20): Buffer {
  // Size0|H|VER|P with P=0 (LSB), then size1/size2 zeros, then body
  const header = Buffer.from([0x00, 0x00, 0x00]);
  return Buffer.concat([header, Buffer.alloc(bodyLen, 0x7b)]);
}

/** Inter frame: P=1 (LSB set). */
function makeVp8Delta(bodyLen = 20): Buffer {
  const header = Buffer.from([0x01, 0x00, 0x00]); // P=1
  return Buffer.concat([header, Buffer.alloc(bodyLen, 0x55)]);
}

describe("packages/rtp/tests/codec/vp8.test.ts", () => {
  it("minimal descriptor: first packet S=1 (0x10), continuation S=0", () => {
    // Arrange: MTU より大きいフレームで複数パケット化
    const frame = makeVp8Keyframe(100);
    const packetizer = new Vp8Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 40,
    });
    // Act
    const packets = packetizer.packetize(frame, 90000);
    // Assert: RFC 7741 §4.2 — 先頭 S=1 PID=0、継続 S=0
    expect(packets.length).toBeGreaterThan(1);
    expect(packets[0].payload[0]).toBe(0x10);
    for (let i = 1; i < packets.length; i++) {
      expect(packets[i].payload[0]).toBe(0x00);
    }
    // 最終のみ marker
    expect(packets.at(-1)!.header.marker).toBe(true);
    for (let i = 0; i < packets.length - 1; i++) {
      expect(packets[i].header.marker).toBe(false);
    }
  });

  it("round-trips frame via dePacketizeRtpPackets", () => {
    // Arrange
    const frame = makeVp8Keyframe(1500);
    const packetizer = new Vp8Packetizer({ sequenceNumber: 10 });
    // Act: フラグメントしてから復元
    const packets = packetizer.packetize(frame, 90000);
    const depacketized = dePacketizeRtpPackets("VP8", packets);
    // Assert: descriptor 除去後の連結が元フレーム
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  it("detects keyframe from P bit on first packet (RFC 7741 §4.3)", () => {
    // Arrange
    const key = makeVp8Keyframe(10);
    const delta = makeVp8Delta(10);
    const packetizer = new Vp8Packetizer({ sequenceNumber: 1 });
    // Act
    const keyPkts = packetizer.packetize(key, 0);
    const deltaPkts = new Vp8Packetizer({ sequenceNumber: 2 }).packetize(
      delta,
      0,
    );
    const keyPayload = Vp8RtpPayload.deSerialize(keyPkts[0].payload);
    const deltaPayload = Vp8RtpPayload.deSerialize(deltaPkts[0].payload);
    // Assert: P=0 → keyframe, P=1 → not
    expect(keyPayload.sBit).toBe(1);
    expect(keyPayload.pid).toBe(0);
    expect(keyPayload.isKeyframe).toBe(true);
    expect(deltaPayload.isKeyframe).toBe(false);
    expect(dePacketizeRtpPackets("VP8", keyPkts).isKeyframe).toBe(true);
  });

  it("rejects maxPayloadSize too small for descriptor", () => {
    // Act / Assert
    expect(() =>
      new Vp8Packetizer({ maxPayloadSize: 1 }).packetize(
        Buffer.from([0x00, 0x00, 0x00]),
        0,
      ),
    ).toThrow(/too small/);
  });

  it("returns empty for empty frame", () => {
    // Act
    const packets = new Vp8Packetizer().packetize(Buffer.alloc(0), 0);
    // Assert
    expect(packets).toEqual([]);
  });
});
