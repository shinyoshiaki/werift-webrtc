import {
  G722Packetizer,
  G722RtpPayload,
  G722_CLOCK_RATE,
  G722_PAYLOAD_TYPE,
  dePacketizeRtpPackets,
} from "../../src";

// RFC 3551 §4.5.2 — G.722 RTP clock is 8000 Hz (not 16000)
// RFC 3551 Table 4 — static PT 9

describe("packages/rtp/tests/codec/g722.test.ts", () => {
  it("static payload type and RTP clock rate constants", () => {
    // Assert: RFC 3551 §4.5.2 / Table 4
    expect(G722_PAYLOAD_TYPE).toBe(9);
    expect(G722_CLOCK_RATE).toBe(8000);
  });

  it("deSerialize returns raw payload", () => {
    // Arrange
    const raw = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    // Act
    const res = G722RtpPayload.deSerialize(raw);
    // Assert
    expect(res.payload).toEqual(raw);
    expect(G722RtpPayload.isDetectedFinalPacketInSequence({} as any)).toBe(
      true,
    );
  });

  it("packetize/depacketize round-trip with PT 9", () => {
    // Arrange: 20ms @ 16kHz = 320 bytes
    const frame = Buffer.alloc(320, 0xab);
    const packetizer = new G722Packetizer({ sequenceNumber: 10 });
    // Act
    const packets = packetizer.packetize(frame, 5000);
    const restored = dePacketizeRtpPackets("G722", packets);
    // Assert
    expect(restored.data).toEqual(frame);
    expect(packets[0].header.payloadType).toBe(G722_PAYLOAD_TYPE);
    expect(packets[0].header.timestamp).toBe(5000);
    expect(packets[0].header.marker).toBe(true);
  });

  it("timestamp advances at 8 kHz for 20 ms frames", () => {
    // Arrange: 40ms of audio = 640 bytes @ 16 kHz sample rate
    const data = Buffer.alloc(640, 0xcc);
    const packetizer = new G722Packetizer({
      sequenceNumber: 0,
      frameDurationInMs: 20,
    });
    // Act
    const packets = packetizer.packetize(data, 0);
    // Assert: 2 packets; timestamp +160 (8 kHz * 0.02s), not +320
    expect(packets.length).toBe(2);
    expect(packets[0].header.timestamp).toBe(0);
    expect(packets[1].header.timestamp).toBe(160);
  });
});
