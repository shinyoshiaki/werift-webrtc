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
    const sample = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(10, 0x55)]);
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
    const frame = Buffer.concat([Buffer.from([0x30]), Buffer.alloc(50, 0x11)]);
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

  // --- size field 付き OBU（obu_has_size_field + LEB128）---

  /**
   * Build OBU with size field: F=0, type, X=0, S=1, R=0 + leb128(body) + body.
   * Header bit layout matches AV1Obu / getBit (MSB first).
   */
  function makeObuWithSize(typeId: number, body: Buffer): Buffer {
    // F(1)|type(4)|X(1)|S(1)|R(1) → S=1
    const header = Buffer.from([((typeId & 0x0f) << 3) | 0x02]);
    return Buffer.concat([header, leb128encode(body.length), body]);
  }

  /** OBU without size field (remainder is body). Header S=0. */
  function makeObuNoSize(typeId: number, body: Buffer): Buffer {
    const header = Buffer.from([(typeId & 0x0f) << 3]);
    return Buffer.concat([header, body]);
  }

  it("splitAv1Obus parses size-fielded single and multi OBU", () => {
    // Arrange: SEQUENCE_HEADER + FRAME both with size
    const obu1 = makeObuWithSize(1, Buffer.from([0xaa, 0xbb]));
    const obu2 = makeObuWithSize(6, Buffer.from([0x11, 0x22, 0x33]));
    const sample = Buffer.concat([obu1, obu2]);
    // Act
    const obus = splitAv1Obus(sample);
    // Assert: 各 OBU が size を含めて分割される
    expect(obus.length).toBe(2);
    expect(obus[0].equals(obu1)).toBe(true);
    expect(obus[1].equals(obu2)).toBe(true);
  });

  it("AV1Obu.deSerialize strips LEB128 so serialize round-trips size-field OBU", () => {
    // Arrange
    const body = Buffer.alloc(128, 0xab);
    const wire = makeObuWithSize(6, body);
    // Act: size field を正しく読んでから再 serialize
    const obu = AV1Obu.deSerialize(wire);
    // Assert: payload は body のみ（LEB128 を含まない）
    expect(obu.obu_has_size_field).toBe(1);
    expect(obu.payload.equals(body)).toBe(true);
    expect(obu.serialize().equals(wire)).toBe(true);
  });

  it("packetize/depacketize round-trips size-fielded single OBU", () => {
    // Arrange: size field 付き単一 OBU
    const frame = makeObuWithSize(6, Buffer.alloc(40, 0x55));
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 0, { isKeyframe: true });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: 元の OBU 列（size field 含む）へ復元
    expect(packets.length).toBe(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  it("packetize/depacketize round-trips multi OBU with size fields", () => {
    // Arrange: 先頭 size 付き + 末尾 size 無し（典型的な AU）
    const obu1 = makeObuWithSize(1, Buffer.from([0x01, 0x02, 0x03]));
    const obu2 = makeObuNoSize(6, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const frame = Buffer.concat([obu1, obu2]);
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 0, { frameType: "key" });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert
    expect(packets.length).toBe(2);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  it("packetize/depacketize round-trips fragmented size-fielded OBU", () => {
    // Arrange: MTU 超過の size field 付き OBU を断片化
    const body = Buffer.alloc(500, 0x77);
    const frame = makeObuWithSize(6, body);
    const packetizer = new Av1Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 80,
    });
    // Act
    const packets = packetizer.packetize(frame, 90_000, { isKeyframe: true });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: 断片 Z/Y 後も size field 付き元列へ復元
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });
});
