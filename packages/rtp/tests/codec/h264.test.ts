import {
  H264Packetizer,
  H264RtpPayload,
  NalUnitType,
  buildH264StapA,
  dePacketizeRtpPackets,
  splitH264NalUnits,
} from "../../src";

// RFC 6184 — Single NAL §5.6, STAP-A §5.7.1, FU-A §5.8
// from pion-rtp (singlePayload) + packetizer round-trips

function annexB(...nalus: Buffer[]): Buffer {
  const sc = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat(nalus.flatMap((n) => [sc, n]));
}

/** NAL header: F=0, NRI=3, type */
function makeNal(type: number, body: Buffer, nri = 3): Buffer {
  return Buffer.concat([Buffer.from([(nri << 5) | (type & 0x1f)]), body]);
}

/** Extract NAL bodies from Annex-B for comparison (ignore start codes). */
function stripAnnexB(data: Buffer): Buffer[] {
  return splitH264NalUnits(data);
}

describe("packages/rtp/tests/codec/h264.test.ts", () => {
  const singlePayload = Buffer.from([0x90, 0x90, 0x90]);
  const singlePayloadUnmarshaled = Buffer.from([
    0x00, 0x00, 0x00, 0x01, 0x90, 0x90, 0x90,
  ]);

  it("singlePayload", () => {
    const res = H264RtpPayload.deSerialize(singlePayload).payload;
    expect(res).toEqual(singlePayloadUnmarshaled);
  });

  it("packetize single NAL Annex-B and round-trips", () => {
    // Arrange
    const nal = makeNal(1, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    const sample = annexB(nal);
    const packetizer = new H264Packetizer({ sequenceNumber: 7 });
    // Act
    const packets = packetizer.packetize(sample, 90000);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: 1 パケット、marker、Annex-B 復元
    expect(packets.length).toBe(1);
    expect(packets[0].header.marker).toBe(true);
    expect(packets[0].header.sequenceNumber).toBe(7);
    expect(frame.data).toEqual(sample);
  });

  it("packetize accepts length-prefixed (AVCC) input", () => {
    // Arrange: 4-byte length + NAL
    const nal = makeNal(1, Buffer.from([0x01, 0x02]));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length, 0);
    const sample = Buffer.concat([len, nal]);
    const packetizer = new H264Packetizer({ naluLengthSize: 4 });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: depacketizer は Annex-B 出力
    expect(frame.data).toEqual(annexB(nal));
  });

  it("packetize fragments large NAL as FU-A and round-trips (RFC 6184 §5.8)", () => {
    // Arrange
    const body = Buffer.alloc(500, 0xab);
    const nal = makeNal(1, body);
    const sample = annexB(nal);
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 100,
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: FU-A 分割・最終 marker・NAL 本体一致
    expect(packets.length).toBeGreaterThan(1);
    expect(packets[0].payload[0] & 0x1f).toBe(NalUnitType.fu_a);
    expect(packets.at(-1)!.header.marker).toBe(true);
    expect(stripAnnexB(frame.data)).toEqual([nal]);
  });

  it("STAP-A aggregates SPS+PPS on keyframe (RFC 6184 §5.7.1)", () => {
    // Arrange: SPS/PPS を parameterSets、IDR のみサンプル
    const sps = makeNal(NalUnitType.sps, Buffer.from([0x11, 0x22]));
    const pps = makeNal(NalUnitType.pps, Buffer.from([0x33]));
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([0xaa, 0xbb]));
    const sample = annexB(idr);
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      parameterSets: [sps, pps],
      maxPayloadSize: 1200,
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    // Assert: 先頭が STAP-A、2 パケット（STAP-A + IDR）
    expect(packets.length).toBe(2);
    expect(packets[0].payload[0] & 0x1f).toBe(NalUnitType.stap_a);
    expect(packets[0].header.marker).toBe(false);
    expect(packets[1].header.marker).toBe(true);
    // STAP-A を deSerialize すると SPS+PPS が Annex-B 連結
    const stap = H264RtpPayload.deSerialize(packets[0].payload);
    expect(stap.payload).toEqual(annexB(sps, pps));
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    expect(stripAnnexB(frame.data)).toEqual([sps, pps, idr]);
    expect(frame.isKeyframe).toBe(true);
  });

  it("falls back to Single NAL when STAP-A does not fit MTU", () => {
    // Arrange: 極端に小さい MTU で STAP-A 不可
    const sps = makeNal(NalUnitType.sps, Buffer.alloc(40, 0x11));
    const pps = makeNal(NalUnitType.pps, Buffer.alloc(40, 0x22));
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([0xaa]));
    const sample = annexB(idr);
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      parameterSets: [sps, pps],
      // 1 + (2+41) + (2+41) = 87 > 50 → cannot STAP both
      maxPayloadSize: 50,
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    // Assert: STAP-A 無し、個別 Single NAL（または FU）
    const types = packets.map((p) => p.payload[0] & 0x1f);
    expect(types).not.toContain(NalUnitType.stap_a);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    expect(stripAnnexB(frame.data)).toEqual([sps, pps, idr]);
  });

  it("does not double-prepend parameter sets when sample already has them", () => {
    // Arrange: サンプル内に SPS/PPS 済み
    const sps = makeNal(NalUnitType.sps, Buffer.from([1]));
    const pps = makeNal(NalUnitType.pps, Buffer.from([2]));
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([3]));
    const sample = annexB(sps, pps, idr);
    const packetizer = new H264Packetizer({
      parameterSets: [sps, pps],
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: 二重付与なし
    expect(stripAnnexB(frame.data)).toEqual([sps, pps, idr]);
  });

  it("buildH264StapA sets F OR and max NRI (RFC 6184 §5.7.1)", () => {
    // Arrange: NRI=1 and NRI=3
    const n1 = makeNal(7, Buffer.from([0x01]), 1);
    const n2 = makeNal(8, Buffer.from([0x02]), 3);
    // Act
    const stap = buildH264StapA([n1, n2]);
    // Assert: Type=24, NRI=3, F=0
    expect(stap[0] & 0x1f).toBe(24);
    expect((stap[0] >> 5) & 0x03).toBe(3);
    expect(stap[0] >> 7).toBe(0);
  });

  it("detects IDR keyframe on single NAL type 5", () => {
    // Arrange / Act
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([0x00]));
    const res = H264RtpPayload.deSerialize(idr);
    // Assert
    expect(res.isKeyframe).toBe(true);
  });

  it("returns empty for empty sample", () => {
    // Act
    expect(new H264Packetizer().packetize(Buffer.alloc(0), 0)).toEqual([]);
  });
});
