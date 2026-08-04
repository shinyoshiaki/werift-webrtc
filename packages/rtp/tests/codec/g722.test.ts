import { readFileSync } from "fs";
import { join } from "path";

import {
  G722Packetizer,
  G722RtpPayload,
  G722_CLOCK_RATE,
  G722_OCTET_RATE,
  G722_PAYLOAD_TYPE,
  dePacketizeRtpPackets,
} from "../../src";
import { loadPayloadVector } from "../utils";

// RFC 3551 §4.5.2 — G.722 RTP clock AND octet rate are both 8000 Hz
// (not 16000 samples → 320 bytes). 20 ms = 160 octets, TS += 160.

describe("packages/rtp/tests/codec/g722.test.ts", () => {
  it("static payload type, clock rate, and octet rate constants", () => {
    // Assert: RFC 3551 §4.5.2 / Table 4
    expect(G722_PAYLOAD_TYPE).toBe(9);
    expect(G722_CLOCK_RATE).toBe(8000);
    expect(G722_OCTET_RATE).toBe(8000);
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

  it("packetize/depacketize round-trip: 20ms = 160 octets", () => {
    // Arrange: RFC 3551 octet rate 8000 → 20ms = 160 bytes
    const frame = Buffer.alloc(160, 0xab);
    const packetizer = new G722Packetizer({ sequenceNumber: 10 });
    // Act
    const packets = packetizer.packetize(frame, 5000);
    const restored = dePacketizeRtpPackets("G722", packets);
    // Assert
    expect(packets.length).toBe(1);
    expect(packets[0].payload.length).toBe(160);
    expect(restored.data).toEqual(frame);
    expect(packets[0].header.payloadType).toBe(G722_PAYLOAD_TYPE);
    expect(packets[0].header.timestamp).toBe(5000);
    expect(packets[0].header.marker).toBe(true);
  });

  it("timestamp advances 1:1 with octets at 8 kHz for 20 ms frames", () => {
    // Arrange: 40ms = 320 octets @ 8000 octets/s → two 160-octet packets
    const data = Buffer.alloc(320, 0xcc);
    const packetizer = new G722Packetizer({
      sequenceNumber: 0,
      frameDurationInMs: 20,
    });
    // Act
    const packets = packetizer.packetize(data, 0);
    // Assert: 2 packets of 160; TS +160 each (not +320 from wrong 16k model)
    expect(packets.length).toBe(2);
    expect(packets[0].payload.length).toBe(160);
    expect(packets[1].payload.length).toBe(160);
    expect(packets[0].header.timestamp).toBe(0);
    expect(packets[1].header.timestamp).toBe(160);
  });

  it("MTU split advances timestamp by chunk octet count", () => {
    // Arrange
    const data = Buffer.alloc(250, 0x11);
    const packetizer = new G722Packetizer({
      sequenceNumber: 3,
      maxPayloadSize: 100,
      frameDurationInMs: 1000, // large frame so MTU dominates
    });
    // Act
    const packets = packetizer.packetize(data, 8000);
    // Assert: TS はオクテット数分だけ進む (1:1)
    expect(packets.length).toBe(3);
    expect(packets[0].header.timestamp).toBe(8000);
    expect(packets[1].header.timestamp).toBe(8100);
    expect(packets[2].header.timestamp).toBe(8200);
    expect(packets[2].payload.length).toBe(50);
    expect(packets.every((p) => p.header.marker)).toBe(true);
  });

  it("loads committed vector_g722.bin and round-trips expected body", () => {
    // Arrange
    const payloads = loadPayloadVector("vector_g722.bin");
    expect(payloads.length).toBeGreaterThan(0);
    const expectedPath = join(__dirname, "../data/vector_g722_expected.bin");
    const expected = readFileSync(expectedPath);
    // Act
    const restored = Buffer.concat(
      payloads.map((p) => G722RtpPayload.deSerialize(p).payload),
    );
    // Assert: 20ms @ 8000 octets/s = 160
    expect(restored).toEqual(expected);
    expect(restored.length).toBe(160);
  });
});
