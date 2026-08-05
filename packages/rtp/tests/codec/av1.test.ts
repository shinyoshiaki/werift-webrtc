import {
  AV1Obu,
  AV1RtpPayload,
  Av1Packetizer,
  createAv1AggregationHeader,
  dePacketizeRtpPackets,
  leb128decode,
  splitAv1Obus,
} from "../../src";
import { leb128encode } from "../../src/codec/leb128";

describe("codec/av1 leb128", () => {
  test.each([
    [0, "00"],
    [127, "7f"],
    [128, "8001"],
    [255, "ff01"],
    [16384, "808001"],
  ])("encode/decode round-trip for %i", (value, hex) => {
    // Act: encode して decode で戻す
    const encoded = leb128encode(value as number);
    const [decoded, bytes] = leb128decode(encoded);

    // Assert: 期待 hex と往復結果が一致すること
    expect(encoded.toString("hex")).toBe(hex);
    expect(decoded).toBe(value);
    expect(bytes).toBe(encoded.length);
  });

  test("rejects negative, non-integer, and unsafe values on encode", () => {
    // Act / Assert: 不正入力を拒否すること
    expect(() => leb128encode(-1)).toThrow();
    expect(() => leb128encode(1.5)).toThrow();
    expect(() => leb128encode(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  test("rejects incomplete decode input", () => {
    // Arrange: continuation bit が立ったまま終端がない入力
    const incomplete = Buffer.from([0x80]);

    // Act / Assert: 終端のない入力を拒否すること
    expect(() => leb128decode(incomplete)).toThrow(/incomplete/);
  });

  test("AV1 OBU serialize with size field uses leb128encode", () => {
    // Arrange
    const obu = new AV1Obu();
    obu.obu_forbidden_bit = 0;
    obu.obu_type = "OBU_FRAME";
    obu.obu_extension_flag = 0;
    obu.obu_has_size_field = 1;
    obu.obu_reserved_1bit = 0;
    obu.payload = Buffer.alloc(128, 0xab);

    // Act: size field 付きで serialize する
    const serialized = obu.serialize();

    // Assert: header(1) + leb128(128=0x80 0x01) + payload
    expect(serialized.subarray(1, 3).toString("hex")).toBe("8001");
    expect(serialized.subarray(3).equals(obu.payload)).toBe(true);
  });
});

// AV1 RTP §4.4 Aggregation Header + packetizer (W=1, Z/Y/N)

describe("codec/av1 packetizer", () => {
  it("createAv1AggregationHeader rejects N=1 and Z=1 together", () => {
    // Act / Assert: AV1 RTP §4.4 の制約
    expect(() =>
      createAv1AggregationHeader({
        startsWithFragment: true,
        endsWithFragment: false,
        startsNewCodedVideoSequence: true,
      }),
    ).toThrow(/N=1 and Z=1/);
  });

  it("splitAv1Obus handles no-size-field single OBU", () => {
    // Arrange: header 0x30 (type FRAME, no size) + payload
    const sample = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(10, 0x55),
    ]);
    // Act
    const obus = splitAv1Obus(sample);
    // Assert
    expect(obus.length).toBe(1);
    expect(obus[0].equals(sample)).toBe(true);
  });

  it("packetizes fragmented keyframe with Z/Y/N bits (AV1 RTP §4.4)", () => {
    // Arrange: size field 無し単一 OBU、断片化が必要
    const frame = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(2_600, 0x55),
    ]);
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 90_000, { frameType: "key" });
    const payloads = packets.map((p) => AV1RtpPayload.deSerialize(p.payload));
    // Assert: N は先頭のみ、Z/Y 断片ビット、最終 marker
    expect(packets.length).toBeGreaterThan(2);
    expect(payloads[0].nBit_RtpStartsNewCodedVideoSequence).toBe(1);
    expect(payloads[0].zBit_RtpStartsWithFragment).toBe(0);
    expect(payloads[0].yBit_RtpEndsWithFragment).toBe(1);
    payloads.slice(1, -1).forEach((payload) => {
      expect(payload.nBit_RtpStartsNewCodedVideoSequence).toBe(0);
      expect(payload.zBit_RtpStartsWithFragment).toBe(1);
      expect(payload.yBit_RtpEndsWithFragment).toBe(1);
    });
    expect(payloads.at(-1)?.nBit_RtpStartsNewCodedVideoSequence).toBe(0);
    expect(payloads.at(-1)?.zBit_RtpStartsWithFragment).toBe(1);
    expect(payloads.at(-1)?.yBit_RtpEndsWithFragment).toBe(0);
    expect(packets.at(-1)?.header.marker).toBe(true);
  });

  it("round-trips OBUs via dePacketizeRtpPackets / getFrame", () => {
    // Arrange（webrtc userMedia.packetizer.test と同等）
    const frame = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(1_500, 0x55),
    ]);
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 90_000, { isKeyframe: true });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  it("delta frame does not set N bit", () => {
    // Arrange
    const frame = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(50, 0x11),
    ]);
    // Act
    const packets = new Av1Packetizer({ sequenceNumber: 1 }).packetize(
      frame,
      0,
      { frameType: "delta" },
    );
    const first = AV1RtpPayload.deSerialize(packets[0].payload);
    // Assert
    expect(first.nBit_RtpStartsNewCodedVideoSequence).toBe(0);
    expect(dePacketizeRtpPackets("AV1", packets).isKeyframe).toBe(false);
  });
});

