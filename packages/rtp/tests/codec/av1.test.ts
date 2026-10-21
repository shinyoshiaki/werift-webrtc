import { existsSync, readFileSync } from "fs";
import { join } from "path";

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
import { loadPayloadVector } from "../utils";

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

// AV1 RTP §4.4 Aggregation Header + packetizer (W=0, Z/Y/N)

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
    const packets = packetizer.packetize(frame, 90_000, {
      frameType: "key",
      startsNewCodedVideoSequence: true,
    });
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
    const packets = packetizer.packetize(frame, 90_000, {
      isKeyframe: true,
      startsNewCodedVideoSequence: true,
    });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  it("round-trips two adjacent fragmented OBUs without dropping the second", () => {
    // Arrange: size field 付き OBU を 2 つ、どちらも MTU を超える（元データが期待値）
    const makeObu = (fill: number) =>
      Buffer.concat([
        Buffer.from([0x32]),
        Buffer.from(leb128encode(1_500)),
        Buffer.alloc(1_500, fill),
      ]);
    const frame = Buffer.concat([makeObu(0x11), makeObu(0x22)]);
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 90_000, {
      isKeyframe: true,
      startsNewCodedVideoSequence: true,
    });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: 各 OBU は RTP 往復後の正規化形式で復元される
    expect(packets.length).toBeGreaterThan(2);
    expect(depacketized.data.length).toBe(canonicalizeObuSizes(frame).length);
    expect(depacketized.data.equals(canonicalizeObuSizes(frame))).toBe(true);
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

  /** RTP 往復後に非末尾 OBU は size field 付き、末尾 OBU は無しに正規化する */
  function canonicalizeObuSizes(frame: Buffer): Buffer {
    const obus = splitAv1Obus(frame);
    return Buffer.concat(
      obus.map((wire, index) => {
        const obu = AV1Obu.deSerialize(wire);
        obu.obu_has_size_field = index < obus.length - 1 ? 1 : 0;
        return obu.serialize();
      }),
    );
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

  it("omits internal OBU size fields from RTP elements", () => {
    // Arrange: サイズ付きの Sequence Header と分割される Frame OBU を用意する
    const sequenceHeader = makeObuWithSize(1, Buffer.from([0xaa, 0xbb]));
    const frameObu = makeObuWithSize(6, Buffer.alloc(500, 0x55));
    const frame = Buffer.concat([sequenceHeader, frameObu]);
    const packetizer = new Av1Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 80,
    });

    // Act: RTP packet 化し、先頭 packet と各 OBU の先頭 fragment を読む
    const packets = packetizer.packetize(frame, 90_000, {
      frameType: "key",
      startsNewCodedVideoSequence: true,
    });
    const firstPacket = AV1RtpPayload.deSerialize(packets[0].payload);
    const obuStarts = packets
      .flatMap(
        (packet) => AV1RtpPayload.deSerialize(packet.payload).obu_or_fragment,
      )
      .filter((obu) => !obu.isContinuation);

    // Assert: Sequence Header と Frame fragment を同じ packet にまとめ、内部 size field を省略する
    expect(firstPacket.w_RtpNumObus).toBe(0);
    expect(firstPacket.obu_or_fragment).toHaveLength(2);
    expect(firstPacket.yBit_RtpEndsWithFragment).toBe(1);
    expect(firstPacket.nBit_RtpStartsNewCodedVideoSequence).toBe(1);
    expect(obuStarts).toHaveLength(2);
    expect(
      obuStarts.every(
        (obu) => AV1Obu.deSerialize(obu.data).obu_has_size_field === 0,
      ),
    ).toBe(true);
    expect(dePacketizeRtpPackets("AV1", packets).data).toEqual(
      canonicalizeObuSizes(frame),
    );
  });

  it("packetize/depacketize round-trips size-fielded single OBU", () => {
    // Arrange: size field 付き単一 OBU
    const frame = makeObuWithSize(6, Buffer.alloc(40, 0x55));
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 0, {
      isKeyframe: true,
      startsNewCodedVideoSequence: true,
    });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: RTP から復元できる正規化 OBU 列になる
    expect(packets.length).toBe(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(canonicalizeObuSizes(frame))).toBe(true);
  });

  it("packetize/depacketize round-trips multi OBU with size fields", () => {
    // Arrange: 先頭 size 付き + 末尾 size 無し（典型的な AU）
    const obu1 = makeObuWithSize(1, Buffer.from([0x01, 0x02, 0x03]));
    const obu2 = makeObuNoSize(6, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const frame = Buffer.concat([obu1, obu2]);
    const packetizer = new Av1Packetizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(frame, 0, {
      frameType: "key",
      startsNewCodedVideoSequence: true,
    });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: 2 つの OBU は 1 packet に集約されて元の列へ復元される
    expect(packets.length).toBe(1);
    expect(AV1RtpPayload.deSerialize(packets[0].payload).w_RtpNumObus).toBe(0);
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
    const packets = packetizer.packetize(frame, 90_000, {
      isKeyframe: true,
      startsNewCodedVideoSequence: true,
    });
    const depacketized = dePacketizeRtpPackets("AV1", packets);
    // Assert: 断片 Z/Y 後に正規化された OBU 列へ復元
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(canonicalizeObuSizes(frame))).toBe(true);
  });

  it("loads committed AV1 vector and getFrame matches expected", () => {
    // Arrange: synthetic size-field OBU（GST に rtpav1pay が無い環境向け）
    const path = join(__dirname, "../data/vector_av1.bin");
    expect(existsSync(path)).toBe(true);
    const payloads = loadPayloadVector("vector_av1.bin");
    const expected = readFileSync(
      join(__dirname, "../data/vector_av1_expected.bin"),
    );
    // Act
    expect(payloads.length).toBeGreaterThan(0);
    const chunks = payloads.map((p) => AV1RtpPayload.deSerialize(p));
    const frame = AV1RtpPayload.getFrame(chunks);
    // Assert
    expect(frame).toEqual(expected);
    expect(frame.length).toBeGreaterThan(0);
  });

  it("parses W=0 payloads where every OBU element has a length prefix", () => {
    // Arrange: W=0, 2 つの OBU 要素（どちらも長さ前置）
    const obuA = Buffer.from([0x30, 0x01, 0x02]);
    const obuB = Buffer.from([0x30, 0x03]);
    const buf = Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from([obuA.length]),
      obuA,
      Buffer.from([obuB.length]),
      obuB,
    ]);
    // Act
    const p = AV1RtpPayload.deSerialize(buf);
    // Assert
    expect(p.obu_or_fragment.map((o) => o.data)).toEqual([obuA, obuB]);
    expect(p.obu_or_fragment.every((o) => !o.isFragment)).toBe(true);
  });

  it("sets N only when a coded video sequence starts, not for every keyframe", () => {
    // Arrange: Sequence Header OBU (type 1) 付き / 無しの keyframe
    const seqHdr = Buffer.from([0x0a, 0x01, 0x00]); // type=1, has_size, size=1
    const frameObu = Buffer.from([0x32, 0x02, 0x55, 0x55]); // type=6 (FRAME)
    const nBit = (data: Buffer, opts: object) =>
      AV1RtpPayload.deSerialize(
        new Av1Packetizer({ sequenceNumber: 1 }).packetize(data, 0, opts)[0]
          .payload,
      ).nBit_RtpStartsNewCodedVideoSequence;
    // Act / Assert
    // シーケンスヘッダを含む keyframe → 新しい coded video sequence
    expect(nBit(Buffer.concat([seqHdr, frameObu]), { frameType: "key" })).toBe(
      1,
    );
    // シーケンス途中の keyframe (ヘッダ無し) → N=0
    expect(nBit(frameObu, { frameType: "key" })).toBe(0);
    // ヘッダが繰り返されていても、明示 false なら N=0
    expect(
      nBit(Buffer.concat([seqHdr, frameObu]), {
        frameType: "key",
        startsNewCodedVideoSequence: false,
      }),
    ).toBe(0);
    // delta フレームは明示 true でも指定どおり (out-of-band header 用)
    expect(
      nBit(frameObu, { frameType: "key", startsNewCodedVideoSequence: true }),
    ).toBe(1);
    expect(
      nBit(Buffer.concat([seqHdr, frameObu]), { frameType: "delta" }),
    ).toBe(0);
  });
});

describe("codec/av1 Av1Packetizer layer boundaries", () => {
  // type=6 (FRAME) + extension flag + has_size, 拡張ヘッダの SID だけ変える
  const layerObu = (extension: number) =>
    Buffer.from([0x36, extension, 0x01, 0xaa]);
  const payloadsOf = (data: Buffer) =>
    new Av1Packetizer({ sequenceNumber: 1 }).packetize(data, 0);

  test("異なる spatial_id の OBU は別 packet に分離する", () => {
    // Arrange: SID=0 と SID=1 の OBU 列
    const data = Buffer.concat([layerObu(0x00), layerObu(0x08)]);

    // Act
    const packets = payloadsOf(data);

    // Assert: レイヤーごとに 1 packet、元の OBU が復元できる
    expect(packets).toHaveLength(2);
    expect(packets.at(-1)!.header.marker).toBe(true);
    for (const p of packets) {
      expect(AV1RtpPayload.deSerialize(p.payload).obu_or_fragment).toHaveLength(
        1,
      );
    }
  });

  test("同一レイヤーの OBU は 1 packet に集約する", () => {
    // Arrange
    const data = Buffer.concat([layerObu(0x08), layerObu(0x08)]);

    // Act
    const packets = payloadsOf(data);

    // Assert
    expect(packets).toHaveLength(1);
  });

  test("拡張ヘッダなしの OBU はレイヤー付き OBU と集約できる", () => {
    // Arrange: temporal delimiter (拡張なし) + SID=1 の OBU
    const data = Buffer.concat([Buffer.from([0x12, 0x00]), layerObu(0x08)]);

    // Act
    const packets = payloadsOf(data);

    // Assert
    expect(packets).toHaveLength(1);
  });

  test("断片化された OBU の後に別レイヤーの OBU が来ても分離する", () => {
    // Arrange: MTU を超える SID=0 の OBU と SID=1 の OBU
    const big = Buffer.concat([
      Buffer.from([0x36, 0x00, 0xc8, 0x01]),
      Buffer.alloc(200, 1),
    ]);
    const data = Buffer.concat([big, layerObu(0x08)]);

    // Act
    const packets = new Av1Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 100,
    }).packetize(data, 0);

    // Assert: 最後の packet は SID=1 の OBU のみ
    const last = AV1RtpPayload.deSerialize(packets.at(-1)!.payload);
    expect(last.obu_or_fragment).toHaveLength(1);
    expect(last.obu_or_fragment[0].data.length).toBe(3);
    expect(packets.length).toBeGreaterThan(2);
  });
});
