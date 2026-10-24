import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  buildH264StapA,
  dePacketizeRtpPackets,
  H264Packetizer,
  H264RtpPayload,
  NalUnitType,
  parseAvcDecoderConfigurationRecord,
  selectMissingH264ParameterSets,
  splitH264NalUnits,
} from "../../src";
import {
  createAvcDecoderConfigurationRecord,
  createH264FuAPayloads,
  createH264Nal,
  createH264RtpPackets,
  createH264StapAPayload,
  loadPayloadVector,
} from "../utils";

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

  it("prepends only missing PPS when sample already has SPS (partial keyframe)", () => {
    // Arrange: サンプルは SPS+IDR、parameterSets に SPS+PPS
    // 不具合回帰: 「SPS or PPS のいずれかがあれば全スキップ」だと PPS が欠落する
    const sps = makeNal(NalUnitType.sps, Buffer.from([0x11]));
    const pps = makeNal(NalUnitType.pps, Buffer.from([0x22]));
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([0x33]));
    const sample = annexB(sps, idr);
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      parameterSets: [sps, pps],
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: 欠落していた PPS のみ前置（SPS は二重付与しない）
    expect(stripAnnexB(frame.data)).toEqual([pps, sps, idr]);
    expect(selectMissingH264ParameterSets([sps, pps], [sps, idr])).toEqual([
      pps,
    ]);
  });

  it("prepends only missing SPS when sample already has PPS (partial keyframe)", () => {
    // Arrange: サンプルは PPS+IDR、parameterSets に SPS+PPS
    const sps = makeNal(NalUnitType.sps, Buffer.from([0x11]));
    const pps = makeNal(NalUnitType.pps, Buffer.from([0x22]));
    const idr = makeNal(NalUnitType.idrSlice, Buffer.from([0x33]));
    const sample = annexB(pps, idr);
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      parameterSets: [sps, pps],
    });
    // Act
    const packets = packetizer.packetize(sample, 0);
    const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
    // Assert: 欠落していた SPS のみ前置
    expect(stripAnnexB(frame.data)).toEqual([sps, pps, idr]);
    expect(selectMissingH264ParameterSets([sps, pps], [pps, idr])).toEqual([
      sps,
    ]);
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

  it("packetizer rejects 1-byte NAL with a clear Error (not TypeError)", () => {
    // Arrange: Annex-B のヘッダのみ NAL（1 バイト）は不正として拒否
    const oneByteNal = Buffer.from([0x61]); // type=1, NRI=3, no RBSP
    const sample = annexB(oneByteNal);
    const packetizer = new H264Packetizer({ sequenceNumber: 1 });
    // Act / Assert: 予測可能な Error（TypeError ではない）
    expect(() => packetizer.packetize(sample, 0)).toThrow(/too short/);
    try {
      packetizer.packetize(sample, 0);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(TypeError);
    }
  });

  it("deSerialize rejects empty and short STAP-A/FU without TypeError", () => {
    // Act / Assert: 空ペイロード
    expect(() => H264RtpPayload.deSerialize(Buffer.alloc(0))).toThrow(
      /too short/,
    );
    // STAP-A indicator only (type 24) without size field
    expect(() => H264RtpPayload.deSerialize(Buffer.from([24]))).toThrow(
      /too short/,
    );
    // 1-byte Single NAL is accepted (type 1–23) as full NAL packaging
    const single = H264RtpPayload.deSerialize(Buffer.from([0x61]));
    expect(single.payload).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x01, 0x61]));
  });

  it("loads committed H.264 vector (GStreamer rtph264pay) and matches expected", () => {
    // Arrange
    const path = join(import.meta.dirname, "../data/vector_h264.bin");
    expect(existsSync(path)).toBe(true);
    const payloads = loadPayloadVector("vector_h264.bin");
    const expected = readFileSync(
      join(import.meta.dirname, "../data/vector_h264_expected.bin"),
    );
    // Act: Single / STAP-A / FU-A を順に復元
    expect(payloads.length).toBeGreaterThan(0);
    let fragment: Buffer | undefined;
    const parts: Buffer[] = [];
    for (const p of payloads) {
      const res = H264RtpPayload.deSerialize(p, fragment);
      fragment = res.fragment;
      if (res.payload) {
        parts.push(res.payload);
        if (!res.fragment) fragment = undefined;
      }
    }
    const restored = Buffer.concat(parts);
    // Assert
    expect(restored).toEqual(expected);
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.subarray(0, 4)).toEqual(
      Buffer.from([0x00, 0x00, 0x00, 0x01]),
    );
  });

  it("explicit length-prefixed format reads 4-byte length 300 (00 00 01 2c) as a length", () => {
    // Arrange: 長さ 300 の NAL を 4 byte 長前置で並べた入力（元の NAL が期待値）
    const nal = Buffer.concat([
      Buffer.from([0x65]),
      Buffer.alloc(300 - 1, 0x55),
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(nal.length, 0);
    const sample = Buffer.concat([length, nal]);
    // Act
    const nalus = splitH264NalUnits(sample, 4, "length-prefixed");
    // Assert: 先頭 3 byte が 00 00 01 でも 300 byte の NAL 1 つに分割される
    expect(sample.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0x2c]));
    expect(nalus).toEqual([nal]);
  });

  it("packetizes header-only end-of-sequence / end-of-stream NALs (types 10, 11)", () => {
    // Arrange: RBSP が空の終端 NAL（1 byte）を IDR の後ろに置く
    const idr = makeNal(NalUnitType.idrSlice, Buffer.alloc(20, 0x44));
    for (const type of [10, 11]) {
      const sample = annexB(idr, Buffer.from([type]));
      const packetizer = new H264Packetizer({ sequenceNumber: 1 });
      // Act
      const packets = packetizer.packetize(sample, 90_000);
      // Assert: 1 byte の Single NAL としてそのまま送られ、受信側で復元できる
      expect(packets.length).toBe(2);
      expect(packets[1].payload).toEqual(Buffer.from([type]));
      expect(packets[1].header.marker).toBe(true);
      expect(dePacketizeRtpPackets("MPEG4/ISO/AVC", packets).data).toEqual(
        sample,
      );
    }
    // 他の type の 1 byte NAL は従来どおり拒否
    expect(() =>
      new H264Packetizer().packetize(annexB(Buffer.from([0x65])), 0),
    ).toThrow(/too short/);
  });

  it("auto-detects a 3-byte start code whose next byte looks like a length (00 00 01 HH)", () => {
    // Arrange: 3 byte start code + NAL 長が 0x1HH + 1 になる単一 NAL (誤判定の再現条件)
    const nal = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(357, 0xaa)]);
    const sample = Buffer.concat([Buffer.from([0, 0, 1]), nal]);
    // Act
    const auto = splitH264NalUnits(sample);
    const annexb = splitH264NalUnits(sample, 4, "annexb");
    // Assert: NAL のヘッダが失われず元のまま取り出される
    expect(auto).toEqual([nal]);
    expect(annexb).toEqual([nal]);
    // packetizer 経由でもヘッダが保たれる
    const packets = new H264Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 2000,
    }).packetize(sample, 0);
    expect(packets[0].payload).toEqual(nal);
    // Annex-B 指定で先頭が start code でなければ明示エラー
    expect(() => splitH264NalUnits(nal, 4, "annexb")).toThrow(/start code/);
  });

  it("inserts parameter sets after a leading AUD (type 9)", () => {
    // Arrange: AUD + IDR、SPS/PPS は未収録
    const aud = Buffer.from([0x09, 0xf0]);
    const idr = makeNal(NalUnitType.idrSlice, Buffer.alloc(10, 0x44));
    const sps = makeNal(NalUnitType.sps, Buffer.alloc(6, 0x01));
    const pps = makeNal(NalUnitType.pps, Buffer.alloc(3, 0x02));
    const packetizer = new H264Packetizer({
      sequenceNumber: 1,
      parameterSets: [sps, pps],
    });
    // Act
    const out = dePacketizeRtpPackets(
      "MPEG4/ISO/AVC",
      packetizer.packetize(annexB(aud, idr), 0),
    ).data;
    // Assert: AUD が先頭のまま、SPS/PPS はその直後
    const types = splitH264NalUnits(out).map((n) => n[0] & 0x1f);
    expect(types).toEqual([9, 7, 8, 5]);
  });

  it.each([14, 15, 20])(
    "keeps NAL type %i (prefix / subset SPS / slice extension) in Single NAL and FU-A",
    (type) => {
      // Arrange: 小さい NAL (Single NAL) と MTU 超過 NAL (FU-A) を IDR と並べる
      const idr = makeNal(NalUnitType.idrSlice, Buffer.alloc(10, 0x44));
      const small = makeNal(type, Buffer.from([0x11, 0x22]));
      const large = makeNal(type, Buffer.alloc(300, 0x33));
      for (const target of [small, large]) {
        const sample = annexB(idr, target);
        const packetizer = new H264Packetizer({
          sequenceNumber: 1,
          maxPayloadSize: 100,
        });
        // Act
        const packets = packetizer.packetize(sample, 0);
        const out = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets).data;
        // Assert: 入力 NAL が欠落せず元のバイト列で往復する
        expect(splitH264NalUnits(sample)).toEqual([idr, target]);
        expect(packets.length).toBeGreaterThan(1);
        expect(splitH264NalUnits(out)).toEqual([idr, target]);
      }
      // 単独 (0 パケットにならない)
      expect(new H264Packetizer().packetize(annexB(small), 0).length).toBe(1);
    },
  );

  describe("isKeyframe (only packets carrying an IDR slice)", () => {
    const sps = createH264Nal(NalUnitType.sps, Buffer.from([0x42, 0x00, 0x1f]));
    const pps = createH264Nal(NalUnitType.pps, Buffer.from([0xce, 0x06, 0xe2]));
    const idr = createH264Nal(NalUnitType.idrSlice, Buffer.alloc(40, 0x88));
    const nonIdr = createH264Nal(1, Buffer.alloc(40, 0x9a), 2);

    it("Single NAL non-IDR whose 2nd byte low 5 bits are 5 is not a keyframe", () => {
      // Arrange: 2 バイト目 0x85 (FU header として読むと type=5 に見える)
      const buf = Buffer.from([0x41, 0x85, 0x00, 0x00]);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: 2 バイト目を FU header として解釈しない
      expect(h264.nalUnitType).toBe(1);
      expect(h264.nalUnitPayloadType).toBeUndefined();
      expect(h264.s).toBeUndefined();
      expect(h264.e).toBeUndefined();
      expect(h264.r).toBeUndefined();
      expect(h264.isKeyframe).toBe(false);
    });

    it("Single NAL IDR is a keyframe", () => {
      // Arrange
      const buf = Buffer.from([0x65, 0x88, 0x84, 0x21]);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: nal_unit_type=5 なので keyframe
      expect(h264.nalUnitType).toBe(NalUnitType.idrSlice);
      expect(h264.isKeyframe).toBe(true);
    });

    it("STAP-A non-IDR whose NALU size upper byte low 5 bits are 5 is not a keyframe", () => {
      // Arrange: NALU size = 0x0501 → 2 バイト目 0x05 (FU header なら type=5)
      const nal = createH264Nal(1, Buffer.alloc(0x0501 - 1, 0x11), 2);
      const buf = createH264StapAPayload([nal]);
      expect(buf[1]).toBe(0x05);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: FU header 由来のフィールドは未設定、内包 NAL type だけ記録
      expect(h264.nalUnitType).toBe(NalUnitType.stap_a);
      expect(h264.nalUnitPayloadType).toBeUndefined();
      expect(h264.s).toBeUndefined();
      expect(h264.e).toBeUndefined();
      expect(h264.aggregatedNalUnitTypes).toEqual([1]);
      expect(h264.isKeyframe).toBe(false);
      // Assert: payload は Annex-B
      expect(h264.payload).toEqual(annexB(nal));
    });

    it("STAP-A with SPS+PPS+IDR is a keyframe", () => {
      // Arrange
      const buf = createH264StapAPayload([sps, pps, idr]);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: 内包 NAL type に IDR が含まれる
      expect(h264.aggregatedNalUnitTypes).toEqual([
        NalUnitType.sps,
        NalUnitType.pps,
        NalUnitType.idrSlice,
      ]);
      expect(h264.isKeyframe).toBe(true);
      // Assert: payload は Annex-B 連結
      expect(h264.payload).toEqual(annexB(sps, pps, idr));
    });

    it("STAP-A with SPS+PPS only is not a keyframe", () => {
      // Arrange
      const buf = createH264StapAPayload([sps, pps]);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: IDR を含まないので false
      expect(h264.aggregatedNalUnitTypes).toEqual([
        NalUnitType.sps,
        NalUnitType.pps,
      ]);
      expect(h264.isKeyframe).toBe(false);
    });

    it("STAP-A with zero-size NALU does not record a type", () => {
      // Arrange: size=0 のエントリを含む
      const buf = Buffer.concat([
        createH264StapAPayload([sps]),
        Buffer.from([0x00, 0x00]),
      ]);
      // Act
      const h264 = H264RtpPayload.deSerialize(buf);
      // Assert: size=0 の NALU からは先頭バイトを読まない
      expect(h264.aggregatedNalUnitTypes).toEqual([NalUnitType.sps]);
      expect(h264.isKeyframe).toBe(false);
    });

    it("FU-A IDR start / middle / end packets are all keyframes and reassemble", () => {
      // Arrange: IDR を 3 分割 (FU header 0x85 / 0x05 / 0x45)
      const payloads = createH264FuAPayloads(idr, 3);
      expect(payloads.map((p) => p[1])).toEqual([0x85, 0x05, 0x45]);
      // Act: フラグメントを順に渡して再構成
      const results: H264RtpPayload[] = [];
      let fragment: Buffer | undefined;
      for (const payload of payloads) {
        const h264 = H264RtpPayload.deSerialize(payload, fragment);
        fragment = h264.fragment;
        results.push(h264);
      }
      // Assert: 全パケットが keyframe
      expect(results.map((r) => r.isKeyframe)).toEqual([true, true, true]);
      expect(results.map((r) => r.isPartitionHead)).toEqual([
        true,
        false,
        false,
      ]);
      // Assert: 終了パケットで 0x65 ヘッダの IDR NAL が Annex-B で再構成される
      const last = results[2];
      expect(last.payload[4]).toBe(0x65);
      expect(last.payload).toEqual(annexB(idr));
    });

    it("FU-A non-IDR is not a keyframe", () => {
      // Arrange: FU indicator 0x5c (NRI=2), FU header 0x81 (S=1, type=1)
      const [start, end] = createH264FuAPayloads(nonIdr, 2);
      expect(start.subarray(0, 2)).toEqual(Buffer.from([0x5c, 0x81]));
      // Act
      const first = H264RtpPayload.deSerialize(start);
      const second = H264RtpPayload.deSerialize(end, first.fragment);
      // Assert: FU header の type=1 なので false
      expect(first.nalUnitPayloadType).toBe(1);
      expect(first.isKeyframe).toBe(false);
      expect(second.isKeyframe).toBe(false);
      // Assert: 再構成結果は元の NAL
      expect(second.payload).toEqual(annexB(nonIdr));
    });

    it("dePacketizeRtpPackets: non-IDR slices only → false, with IDR → true", () => {
      // Arrange: non-IDR のみ (Single NAL 2 バイト目 0x85 / STAP-A size 上位 0x05 / FU-A)
      const misleadingSingle = Buffer.from([0x41, 0x85, 0x00, 0x00]);
      const misleadingStapA = createH264StapAPayload([
        createH264Nal(1, Buffer.alloc(0x0501 - 1, 0x22), 2),
      ]);
      const nonIdrPackets = createH264RtpPackets([
        misleadingSingle,
        misleadingStapA,
        ...createH264FuAPayloads(nonIdr, 2),
      ]);
      // Arrange: STAP-A(SPS+PPS) + FU-A(IDR)
      const idrPackets = createH264RtpPackets([
        createH264StapAPayload([sps, pps]),
        ...createH264FuAPayloads(idr, 2),
      ]);
      // Act
      const nonIdrFrame = dePacketizeRtpPackets("MPEG4/ISO/AVC", nonIdrPackets);
      const idrFrame = dePacketizeRtpPackets("MPEG4/ISO/AVC", idrPackets);
      // Assert: P フレームは keyframe にならない
      expect(nonIdrFrame.isKeyframe).toBe(false);
      // Assert: IDR を含むフレームは keyframe、データは Annex-B で復元
      expect(idrFrame.isKeyframe).toBe(true);
      expect(idrFrame.data).toEqual(annexB(sps, pps, idr));
    });
  });

  describe("parseAvcDecoderConfigurationRecord", () => {
    const sps = makeNal(7, Buffer.from([0x42, 0x00, 0x1e, 0xda, 0x01]));
    const pps = makeNal(8, Buffer.from([0xce, 0x06, 0xe2]));

    it("returns NAL length size and SPS/PPS without length prefixes", () => {
      // Arrange: lengthSizeMinusOne=1 (2-byte NAL length) の avcC
      const record = createAvcDecoderConfigurationRecord({
        sps: [sps],
        pps: [pps],
        naluLengthSize: 2,
      });
      // Act
      const parsed = parseAvcDecoderConfigurationRecord(record);
      // Assert: length size と SPS→PPS 順の parameterSets が取り出せる
      expect(parsed.naluLengthSize).toBe(2);
      expect(parsed.sps).toEqual([sps]);
      expect(parsed.pps).toEqual([pps]);
      expect(parsed.parameterSets).toEqual([sps, pps]);
    });

    it("accepts an ArrayBufferView with a non-zero byteOffset", () => {
      // Arrange: 先頭に余分な byte を持つ backing buffer 上の view
      const record = createAvcDecoderConfigurationRecord({
        sps: [sps],
        pps: [pps],
      });
      const backing = Buffer.concat([Buffer.from([0xaa, 0xbb]), record]);
      const view = new Uint8Array(
        backing.buffer,
        backing.byteOffset + 2,
        record.length,
      );
      // Act
      const parsed = parseAvcDecoderConfigurationRecord(view);
      // Assert: view の範囲だけを読む
      expect(parsed.naluLengthSize).toBe(4);
      expect(parsed.parameterSets).toEqual([sps, pps]);
    });

    it("throws on a truncated record instead of returning partial sets", () => {
      // Arrange: PPS の途中で切れた avcC と 7 byte 未満の avcC
      const record = createAvcDecoderConfigurationRecord({
        sps: [sps],
        pps: [pps],
      });
      // Act / Assert: どちらも明示的なエラーになる
      expect(() =>
        parseAvcDecoderConfigurationRecord(record.subarray(0, -1)),
      ).toThrow(/truncated/);
      expect(() =>
        parseAvcDecoderConfigurationRecord(record.subarray(0, 6)),
      ).toThrow(/at least 7 bytes/);
    });

    it("feeds H264Packetizer so AVCC keyframes get SPS/PPS prepended", () => {
      // Arrange: avcC 由来の parameterSets と、IDR のみを含む AVCC サンプル
      const avc = parseAvcDecoderConfigurationRecord(
        createAvcDecoderConfigurationRecord({ sps: [sps], pps: [pps] }),
      );
      const idr = makeNal(5, Buffer.from([0x88, 0x84, 0x21]));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(idr.length);
      const packetizer = new H264Packetizer({
        naluLengthSize: avc.naluLengthSize,
        parameterSets: avc.parameterSets,
        inputFormat: "length-prefixed",
      });
      // Act
      const packets = packetizer.packetize(Buffer.concat([length, idr]), 0);
      const frame = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);
      // Assert: STAP-A(SPS/PPS) + IDR になり、Annex-B で SPS/PPS/IDR に復元される
      expect(packets.map((p) => p.payload[0] & 0x1f)).toEqual([
        NalUnitType.stap_a,
        5,
      ]);
      expect(frame.data).toEqual(annexB(sps, pps, idr));
    });
  });
});
