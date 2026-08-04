import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  H265Packetizer,
  H265RtpPayload,
  H265_NAL_TYPE,
  H265_PAYLOAD_TYPE_AP,
  H265_PAYLOAD_TYPE_FU,
  dePacketizeRtpPackets,
  parseH265PayloadHeader,
  splitH265NalUnits,
  writeH265PayloadHeader,
} from "../../src";

// RFC 7798 §4.4 — PayloadHdr F/Type/LayerId/TID
// §4.4.1 Single NAL, §4.4.2 AP (Type=48), §4.4.3 FU (Type=49)
// IRAP keyframe types 16–21

/** Build a minimal 2-byte NAL header + body. */
function makeNal(
  type: number,
  body: Buffer,
  layerId = 0,
  tid = 1,
  f = 0,
): Buffer {
  const hdr = writeH265PayloadHeader({ f, type, layerId, tid });
  return Buffer.concat([hdr, body]);
}

function annexB(...nalus: Buffer[]): Buffer {
  const start = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat(nalus.flatMap((n) => [start, n]));
}

describe("packages/rtp/tests/codec/h265.test.ts", () => {
  it("parses PayloadHdr bit layout (RFC 7798 §4.4)", () => {
    // Arrange: F=0, Type=19 (IDR_W_RADL), LayerId=0, TID=1
    // byte0 = (0<<7)|(19<<1)|0 = 0x26, byte1 = (0<<3)|1 = 0x01
    const buf = Buffer.from([0x26, 0x01]);
    // Act
    const h = parseH265PayloadHeader(buf);
    // Assert
    expect(h.f).toBe(0);
    expect(h.type).toBe(19);
    expect(h.layerId).toBe(0);
    expect(h.tid).toBe(1);
    expect(writeH265PayloadHeader(h)).toEqual(buf);
  });

  it("single NAL unit deSerialize to Annex-B", () => {
    // Arrange
    const nal = makeNal(1, Buffer.from([0x11, 0x22, 0x33]));
    // Act
    const res = H265RtpPayload.deSerialize(nal);
    // Assert: 00 00 00 01 + NAL
    expect(res.payload).toEqual(
      Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), nal]),
    );
    expect(res.type).toBe(1);
    expect(res.isKeyframe).toBe(false);
    expect(res.isPartitionHead).toBe(true);
  });

  it("detects IRAP keyframe types 16–21", () => {
    // Act / Assert
    for (let t = 16; t <= 21; t++) {
      const nal = makeNal(t, Buffer.from([0x00]));
      const res = H265RtpPayload.deSerialize(nal);
      expect(res.isKeyframe).toBe(true);
    }
  });

  it("AP aggregates multiple NAL units (RFC 7798 §4.4.2, no DONL)", () => {
    // Arrange: VPS + SPS style small NALs
    const n1 = makeNal(H265_NAL_TYPE.VPS, Buffer.from([0x01, 0x02]));
    const n2 = makeNal(H265_NAL_TYPE.SPS, Buffer.from([0x03, 0x04, 0x05]));
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    const s1 = Buffer.alloc(2);
    s1.writeUInt16BE(n1.length, 0);
    const s2 = Buffer.alloc(2);
    s2.writeUInt16BE(n2.length, 0);
    const ap = Buffer.concat([hdr, s1, n1, s2, n2]);
    // Act
    const res = H265RtpPayload.deSerialize(ap);
    // Assert: Annex-B 連結
    expect(res.type).toBe(H265_PAYLOAD_TYPE_AP);
    expect(res.payload).toEqual(annexB(n1, n2));
  });

  it("AP rejects NALU size that exceeds buffer", () => {
    // Arrange
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    const size = Buffer.from([0x00, 0xff]); // claims 255 bytes
    const ap = Buffer.concat([hdr, size, Buffer.from([0x01])]);
    // Act / Assert
    expect(() => H265RtpPayload.deSerialize(ap)).toThrow(/exceeds buffer/);
  });

  it("FU reassembly with S/E bits (RFC 7798 §4.4.3)", () => {
    // Arrange: large NAL type=1, body split into 2 FUs
    const body = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
    const nalType = 1;
    const layerId = 0;
    const tid = 1;
    const fuHdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_FU,
      layerId,
      tid,
    });
    // S=1 E=0 FuType=1
    const fu1 = Buffer.concat([
      fuHdr,
      Buffer.from([0x80 | nalType]),
      body.subarray(0, 3),
    ]);
    // S=0 E=1 FuType=1
    const fu2 = Buffer.concat([
      fuHdr,
      Buffer.from([0x40 | nalType]),
      body.subarray(3),
    ]);
    // Act
    const part1 = H265RtpPayload.deSerialize(fu1);
    expect(part1.fragment).toBeDefined();
    expect(part1.payload).toBeUndefined();
    const part2 = H265RtpPayload.deSerialize(fu2, part1.fragment);
    // Assert: 復元 NAL = header + body
    const expectedNal = makeNal(nalType, body, layerId, tid);
    expect(part2.payload).toEqual(
      Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), expectedNal]),
    );
    expect(part2.fragment).toBeUndefined();
    expect(part1.isPartitionHead).toBe(true);
    expect(part2.isPartitionHead).toBe(false);
  });

  it("FU start with IRAP FuType reports isKeyframe", () => {
    // Arrange
    const fuHdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_FU,
      layerId: 0,
      tid: 1,
    });
    const fu = Buffer.concat([
      fuHdr,
      Buffer.from([0x80 | 19]), // S=1, IDR_W_RADL
      Buffer.from([0xaa]),
    ]);
    // Act
    const res = H265RtpPayload.deSerialize(fu);
    // Assert
    expect(res.isKeyframe).toBe(true);
  });

  it("packetize single NAL Annex-B and round-trip", () => {
    // Arrange
    const nal = makeNal(1, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const sample = annexB(nal);
    const packetizer = new H265Packetizer({ sequenceNumber: 7 });
    // Act
    const packets = packetizer.packetize(sample, 90000);
    const frame = dePacketizeRtpPackets("H265", packets);
    // Assert
    expect(packets.length).toBe(1);
    expect(packets[0].header.marker).toBe(true);
    expect(packets[0].header.sequenceNumber).toBe(7);
    expect(frame.data).toEqual(sample);
  });

  it("packetize accepts length-prefixed (HVCC) input", () => {
    // Arrange: 4-byte length + NAL
    const nal = makeNal(1, Buffer.from([0x01, 0x02]));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length, 0);
    const sample = Buffer.concat([len, nal]);
    const packetizer = new H265Packetizer({ naluLengthSize: 4 });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("H265", packets);
    // Assert: depacketizer は Annex-B 出力
    expect(frame.data).toEqual(annexB(nal));
  });

  it("packetize fragments large NAL as FU and round-trips", () => {
    // Arrange
    const body = Buffer.alloc(500, 0xab);
    const nal = makeNal(1, body);
    const sample = annexB(nal);
    const packetizer = new H265Packetizer({
      sequenceNumber: 0,
      maxPayloadSize: 100,
    });
    // Act
    const packets = packetizer.packetize(sample, 1234);
    // Assert: FU Type=49
    const firstType = parseH265PayloadHeader(packets[0].payload).type;
    expect(firstType).toBe(H265_PAYLOAD_TYPE_FU);
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.at(-1)!.header.marker).toBe(true);
    for (const p of packets) {
      expect(p.header.timestamp).toBe(1234);
    }
    // ラウンドトリップ
    const frame = dePacketizeRtpPackets("H265", packets);
    expect(frame.data).toEqual(sample);
  });

  it("packetize aggregates parameter sets into AP on keyframe", () => {
    // Arrange: VPS/SPS/PPS + IDR
    const vps = makeNal(H265_NAL_TYPE.VPS, Buffer.from([0x01]));
    const sps = makeNal(H265_NAL_TYPE.SPS, Buffer.from([0x02]));
    const pps = makeNal(H265_NAL_TYPE.PPS, Buffer.from([0x03]));
    const idr = makeNal(H265_NAL_TYPE.IDR_W_RADL, Buffer.from([0x04, 0x05]));
    const sample = annexB(idr); // IDR only; parameter sets via option
    const packetizer = new H265Packetizer({
      sequenceNumber: 0,
      parameterSets: [vps, sps, pps],
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    // Assert: 先頭は AP
    expect(parseH265PayloadHeader(packets[0].payload).type).toBe(
      H265_PAYLOAD_TYPE_AP,
    );
    const frame = dePacketizeRtpPackets("H265", packets);
    // VPS+SPS+PPS+IDR in Annex-B
    expect(frame.data).toEqual(annexB(vps, sps, pps, idr));
    expect(frame.isKeyframe).toBe(true);
  });

  it("splitH265NalUnits parses Annex-B with 3-byte start codes", () => {
    // Arrange
    const n1 = makeNal(1, Buffer.from([0x11]));
    const n2 = makeNal(1, Buffer.from([0x22]));
    const sample = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01]),
      n1,
      Buffer.from([0x00, 0x00, 0x01]),
      n2,
    ]);
    // Act
    const nalus = splitH265NalUnits(sample);
    // Assert
    expect(nalus.length).toBe(2);
    expect(nalus[0]).toEqual(n1);
    expect(nalus[1]).toEqual(n2);
  });

  it("rejects payload shorter than 2 bytes", () => {
    // Act / Assert
    expect(() => H265RtpPayload.deSerialize(Buffer.from([0x01]))).toThrow(
      /too short/,
    );
  });

  it("isDetectedFinalPacketInSequence follows marker", () => {
    // Assert: H.264 と同じ marker 規則
    expect(
      H265RtpPayload.isDetectedFinalPacketInSequence({
        marker: true,
      } as any),
    ).toBe(true);
    expect(
      H265RtpPayload.isDetectedFinalPacketInSequence({
        marker: false,
      } as any),
    ).toBe(false);
  });

  it("loads committed H.265 vector payloads", () => {
    // Arrange: tools/generateVectors 成果物
    const path = join(__dirname, "../data/vector_h265.bin");
    expect(existsSync(path)).toBe(true);
    const buf = readFileSync(path);
    const payloads: Buffer[] = [];
    let offset = 0;
    while (offset + 2 <= buf.length) {
      const len = buf.readUInt16BE(offset);
      offset += 2;
      payloads.push(buf.subarray(offset, offset + len));
      offset += len;
    }
    // Assert: 各ペイロードが deSerialize 可能（不完全 FU は fragment で終了し得る）
    expect(payloads.length).toBeGreaterThan(0);
    let fragment: Buffer | undefined;
    for (const p of payloads) {
      const res = H265RtpPayload.deSerialize(p, fragment);
      fragment = res.fragment;
    }
  });

  // --- wire-format boundary cases (RFC 7798 §4.4) ---

  it("PayloadHdr Type 48 is AP and Type 49 is FU (RFC 7798, not 0/1)", () => {
    // Assert: 定数が RFC 原文どおり
    expect(H265_PAYLOAD_TYPE_AP).toBe(48);
    expect(H265_PAYLOAD_TYPE_FU).toBe(49);
  });

  it("FU PayloadHdr F bit is taken from NAL F (RFC 7798 §4.4.3)", () => {
    // Arrange: F=1 on original NAL → FU PayloadHdr F must be 1
    const body = Buffer.alloc(20, 0x55);
    const nal = makeNal(1, body);
    // Force F=1 on NAL header
    nal[0] = nal[0] | 0x80;
    const packetizer = new H265Packetizer({
      sequenceNumber: 0,
      maxPayloadSize: 12,
    });
    // Act
    const packets = packetizer.packetize(annexB(nal), 0);
    // Assert: FU の F は 1
    expect(packets.length).toBeGreaterThan(1);
    const hdr = parseH265PayloadHeader(packets[0].payload);
    expect(hdr.type).toBe(H265_PAYLOAD_TYPE_FU);
    expect(hdr.f).toBe(1);
  });

  it("AP PayloadHdr uses F=OR, LayerId=min, TID=min (RFC 7798 §4.4.2)", () => {
    // Arrange: NAL0 F=0 LayerId=2 TID=3; NAL1 F=1 LayerId=1 TID=1
    const n0 = makeNal(H265_NAL_TYPE.VPS, Buffer.from([0x01]), 2, 3, 0);
    const n1 = makeNal(H265_NAL_TYPE.SPS, Buffer.from([0x02]), 1, 1, 1);
    const sample = annexB(n0, n1);
    const packetizer = new H265Packetizer({ sequenceNumber: 0 });
    // Act
    const packets = packetizer.packetize(sample, 0);
    // Assert: 先頭は AP、ヘッダは集約規則
    expect(packets.length).toBe(1);
    const hdr = parseH265PayloadHeader(packets[0].payload);
    expect(hdr.type).toBe(H265_PAYLOAD_TYPE_AP);
    expect(hdr.f).toBe(1); // OR
    expect(hdr.layerId).toBe(1); // min
    expect(hdr.tid).toBe(1); // min
  });

  it("AP isKeyframe true when aggregated NAL is IRAP", () => {
    // Arrange: VPS + IDR in one AP
    const vps = makeNal(H265_NAL_TYPE.VPS, Buffer.from([0x01]));
    const idr = makeNal(H265_NAL_TYPE.IDR_W_RADL, Buffer.from([0x02]));
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    const s1 = Buffer.alloc(2);
    s1.writeUInt16BE(vps.length, 0);
    const s2 = Buffer.alloc(2);
    s2.writeUInt16BE(idr.length, 0);
    const ap = Buffer.concat([hdr, s1, vps, s2, idr]);
    // Act
    const res = H265RtpPayload.deSerialize(ap);
    // Assert: AP 内 IRAP を走査
    expect(res.isKeyframe).toBe(true);
  });

  it("AP isKeyframe false when only parameter sets", () => {
    // Arrange
    const vps = makeNal(H265_NAL_TYPE.VPS, Buffer.from([0x01]));
    const sps = makeNal(H265_NAL_TYPE.SPS, Buffer.from([0x02]));
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    const s1 = Buffer.alloc(2);
    s1.writeUInt16BE(vps.length, 0);
    const s2 = Buffer.alloc(2);
    s2.writeUInt16BE(sps.length, 0);
    const ap = Buffer.concat([hdr, s1, vps, s2, sps]);
    // Act
    const res = H265RtpPayload.deSerialize(ap);
    // Assert
    expect(res.isKeyframe).toBe(false);
  });

  it("rejects AP with NALU size of 0 or 1", () => {
    // Arrange
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    const size = Buffer.from([0x00, 0x01]); // 1 byte — too small for NAL header
    const ap = Buffer.concat([hdr, size, Buffer.from([0x00])]);
    // Act / Assert
    expect(() => H265RtpPayload.deSerialize(ap)).toThrow(/too small/);
  });

  it("rejects empty AP payload (header only)", () => {
    // Arrange
    const hdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_AP,
      layerId: 0,
      tid: 1,
    });
    // Act / Assert
    expect(() => H265RtpPayload.deSerialize(hdr)).toThrow(
      /no aggregation units/,
    );
  });

  it("rejects FU with empty FU payload", () => {
    // Arrange: PayloadHdr + FU header only
    const fuHdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_FU,
      layerId: 0,
      tid: 1,
    });
    const emptyFu = Buffer.concat([fuHdr, Buffer.from([0x80 | 1])]);
    // Act / Assert
    expect(() => H265RtpPayload.deSerialize(emptyFu)).toThrow(/empty FU/);
  });

  it("FU intermediate without E leaves fragment and no payload", () => {
    // Arrange
    const fuHdr = writeH265PayloadHeader({
      f: 0,
      type: H265_PAYLOAD_TYPE_FU,
      layerId: 0,
      tid: 1,
    });
    const fu = Buffer.concat([
      fuHdr,
      Buffer.from([0x80 | 1]), // S=1 E=0
      Buffer.from([0xaa, 0xbb]),
    ]);
    // Act
    const res = H265RtpPayload.deSerialize(fu);
    // Assert: 境界 — 不完全 FU は payload 未確定
    expect(res.fragment).toBeDefined();
    expect(res.payload).toBeUndefined();
  });

  it("rejects naluLengthSize outside 1–4 and zero-length NAL", () => {
    // Act / Assert: naluLengthSize 境界
    expect(() => new H265Packetizer({ naluLengthSize: 0 })).toThrow(/1–4/);
    expect(() => new H265Packetizer({ naluLengthSize: 5 })).toThrow(/1–4/);
    // 長さ 0 の NAL
    const zeroLen = Buffer.alloc(4); // 4-byte length = 0
    expect(() =>
      new H265Packetizer({ naluLengthSize: 4 }).packetize(zeroLen, 0),
    ).toThrow(/length 0/);
  });

  it("MTU split FU: shared timestamp, marker only on last", () => {
    // Arrange
    const nal = makeNal(1, Buffer.alloc(400, 0xcd));
    const packetizer = new H265Packetizer({
      sequenceNumber: 5,
      maxPayloadSize: 90,
    });
    // Act
    const packets = packetizer.packetize(annexB(nal), 4242);
    // Assert
    expect(packets.length).toBeGreaterThan(2);
    expect(packets.every((p) => p.header.timestamp === 4242)).toBe(true);
    expect(packets.slice(0, -1).every((p) => !p.header.marker)).toBe(true);
    expect(packets.at(-1)!.header.marker).toBe(true);
    expect(packets[0].header.sequenceNumber).toBe(5);
    expect(packets[1].header.sequenceNumber).toBe(6);
    // Type=49 on all FU packets
    for (const p of packets) {
      expect(parseH265PayloadHeader(p.payload).type).toBe(H265_PAYLOAD_TYPE_FU);
    }
    expect(dePacketizeRtpPackets("H265", packets).data).toEqual(annexB(nal));
  });
});
