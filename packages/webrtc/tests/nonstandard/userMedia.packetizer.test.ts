import { EncodedPacket } from "mediabunny";

import {
  AV1RtpPayload,
  Vp8RtpPayload,
  dePacketizeRtpPackets,
  useAV1X,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from "../../src";
import {
  Vp8Packetizer,
  createPacketizer,
} from "../../src/nonstandard/userMedia/packetizer";
import {
  createAv1TemporalUnitWithSequenceHeader,
  createH264DecoderDescription,
  createOpusFrames,
  createVp8Frames,
  createVp8EncodedPacket,
  h264TestNalUnits,
  toAvccSample,
} from "./userMediaTestUtils";

describe("nonstandard/userMedia packetizer", () => {
  test("packetizes VP8 frames that depacketize back to the original frame", () => {
    const { frame, packet } = createVp8EncodedPacket({ length: 1_500 });
    const packetizer = createPacketizer({
      codec: useVP8(),
      sourceCodec: "vp8",
    });

    // 実行: MTU を超える VP8 フレームを RTP 化して複数 packet に分割する。
    const packets = packetizer.packetize(packet, 90_000);
    const depacketized = dePacketizeRtpPackets("VP8", packets);

    // 検証: 4 byte descriptor を含めても各 payload が 1200 byte 以下で、元フレームへ復元できる。
    expect(packets.length).toBeGreaterThan(1);
    for (const rtp of packets) {
      expect(rtp.payload.length).toBeLessThanOrEqual(1_200);
    }
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  test("emits VP8 X/I/M descriptor with a shared PictureID across fragments", () => {
    const { packet } = createVp8EncodedPacket({ length: 3_000 });
    const packetizer = new Vp8Packetizer({
      payloadType: useVP8().payloadType ?? 96,
      pictureId: 0x03d7,
    });

    // 実行: 3 packet 以上に断片化される VP8 フレームを RTP 化する。
    const packets = packetizer.packetize(Buffer.from(packet.data), 90_000);
    const payloads = packets.map((rtp) =>
      Vp8RtpPayload.deSerialize(rtp.payload),
    );

    // 検証: 先頭断片は 0x90 0x80、後続断片は 0x80 0x80 で、PictureID は M=1 の 15 bit 表現。
    expect(packets.length).toBeGreaterThan(2);
    expect([...packets[0].payload.subarray(0, 4)]).toEqual([
      0x90, 0x80, 0x83, 0xd7,
    ]);
    for (const rtp of packets.slice(1)) {
      expect([...rtp.payload.subarray(0, 4)]).toEqual([0x80, 0x80, 0x83, 0xd7]);
    }

    // 検証: X/I/M=1、L/T/K=0 で、同じフレームの全断片が同じ PictureID を持つ。
    for (const payload of payloads) {
      expect(payload.xBit).toBe(1);
      expect(payload.iBit).toBe(1);
      expect(payload.mBit).toBe(1);
      expect(payload.lBit).toBe(0);
      expect(payload.tBit).toBe(0);
      expect(payload.kBit).toBe(0);
      expect(payload.pictureId).toBe(0x03d7);
    }

    // 検証: marker は最後の packet のみ。
    expect(packets.map((rtp) => rtp.header.marker)).toEqual([
      ...packets.slice(1).map(() => false),
      true,
    ]);
  });

  test("increments VP8 PictureID per frame and wraps after 0x7fff", () => {
    const packetizer = new Vp8Packetizer({
      payloadType: useVP8().payloadType ?? 96,
      pictureId: 0x7ffe,
    });
    const frames = [0, 1, 2].map((index) =>
      createVp8EncodedPacket({
        length: 2_000,
        type: index === 0 ? "key" : "delta",
        timestamp: index / 30,
      }),
    );

    // 実行: 連続する 3 フレームを順に RTP 化する。
    const pictureIds = frames.map(({ packet }, index) =>
      packetizer
        .packetize(Buffer.from(packet.data), index * 3_000)
        .map((rtp) => Vp8RtpPayload.deSerialize(rtp.payload).pictureId),
    );

    // 検証: フレーム内は同じ値で、フレームごとに +1、0x7fff の次は 0 に戻る。
    expect(pictureIds.map((ids) => new Set(ids).size)).toEqual([1, 1, 1]);
    expect(pictureIds.map((ids) => ids[0])).toEqual([0x7ffe, 0x7fff, 0]);
  });

  test("starts VP8 PictureID from a random 15-bit value", () => {
    const { packet } = createVp8EncodedPacket({ length: 100 });
    const packetizer = createPacketizer({
      codec: useVP8(),
      sourceCodec: "vp8",
    });

    // 実行: 既定設定の packetizer で 1 フレームを RTP 化する。
    const [rtp] = packetizer.packetize(packet, 0);
    const payload = Vp8RtpPayload.deSerialize(rtp.payload);

    // 検証: PictureID が 15 bit の範囲に収まる。
    expect(payload.pictureId).toBeGreaterThanOrEqual(0);
    expect(payload.pictureId).toBeLessThanOrEqual(0x7fff);
  });

  test("packetizes VP9 frames that depacketize back to the original frame", () => {
    const frame = Buffer.alloc(1_500, 0x7b);
    const packetizer = createPacketizer({
      codec: useVP9(),
      sourceCodec: "vp9",
    });

    // 実行: 大きめの VP9 フレームを RTP 化して複数 packet に分割する。
    const packets = packetizer.packetize(
      new EncodedPacket(frame, "key", 0, 1 / 30),
      90_000,
    );
    const depacketized = dePacketizeRtpPackets("VP9", packets);

    // 検証: 分割された RTP 群から元の VP9 フレームへ復元できる。
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  test("packetizes AV1 OBUs that depacketize back to the original frame", () => {
    const frame = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(1_500, 0x55),
    ]);
    const packetizer = createPacketizer({
      codec: useAV1X(),
      sourceCodec: "av1",
    });

    // 実行: size field を持たない単一 OBU の AV1 フレームを RTP 化して断片化させる。
    const packets = packetizer.packetize(
      new EncodedPacket(frame, "key", 0, 1 / 30),
      90_000,
    );
    const depacketized = dePacketizeRtpPackets("AV1", packets);

    // 検証: 断片化された RTP 群から元の AV1 OBU 列へ復元できる。
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.isKeyframe).toBe(true);
    expect(depacketized.data.equals(frame)).toBe(true);
  });

  test("sets AV1 fragmentation header bits compatibly for a keyframe", () => {
    const frame = Buffer.concat([
      Buffer.from([0x30]),
      Buffer.alloc(2_600, 0x55),
    ]);
    const packetizer = createPacketizer({
      codec: useAV1X(),
      sourceCodec: "av1",
    });

    // 実行: 断片化が必要な AV1 keyframe を RTP 化して各 packet の aggregation header を読む。
    const packets = packetizer.packetize(
      new EncodedPacket(frame, "key", 0, 1 / 30),
      90_000,
    );
    const payloads = packets.map((packet) =>
      AV1RtpPayload.deSerialize(packet.payload),
    );

    // 検証: N bit は最初の packet のみ立ち、断片継続を示す Z/Y bit と marker が整合する。
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

  test("packs AV1 sequence header with the frame start so only the first packet has Z=0", () => {
    // 準備: Temporal Delimiter + Sequence Header + MTU を超える OBU_FRAME（いずれも size field 付き）
    const frame = createAv1TemporalUnitWithSequenceHeader();
    const packetizer = createPacketizer({
      codec: useAV1X(),
      sourceCodec: "av1",
    });

    // 実行: keyframe を RTP 化して aggregation header を読む。
    const payloads = packetizer
      .packetize(new EncodedPacket(frame, "key", 0, 1 / 30), 0)
      .map((packet) => AV1RtpPayload.deSerialize(packet.payload));

    // 検証: packages/rtp の Av1Packetizer と同じく、先頭だけ Z=0・末尾だけ Y=0 で、先頭は SH + FRAME 断片の 2 要素。
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.map((p) => p.zBit_RtpStartsWithFragment)).toEqual([
      0,
      ...payloads.slice(1).map(() => 1),
    ]);
    expect(payloads.map((p) => p.yBit_RtpEndsWithFragment)).toEqual([
      ...payloads.slice(0, -1).map(() => 1),
      0,
    ]);
    expect(payloads[0].w_RtpNumObus).toBe(2);
    expect(payloads[0].nBit_RtpStartsNewCodedVideoSequence).toBe(1);
  });

  test("prepends avcC SPS/PPS to AVCC H264 keyframes", () => {
    const { sps, pps, idr } = h264TestNalUnits;
    const packetizer = createPacketizer({
      codec: useH264(),
      sourceCodec: "avc",
      decoderDescription: createH264DecoderDescription(),
    });

    // 実行: SPS/PPS を含まない AVCC keyframe を RTP 化して Annex-B へ戻す。
    const packets = packetizer.packetize(
      new EncodedPacket(toAvccSample(idr), "key", 0, 1 / 30),
      0,
    );
    const depacketized = dePacketizeRtpPackets("MPEG4/ISO/AVC", packets);

    // 検証: avcC の SPS/PPS が STAP-A で先頭に付き、末尾 packet のみ marker になる。
    const startCode = Buffer.from([0, 0, 0, 1]);
    expect(packets.map((packet) => packet.payload[0] & 0x1f)).toEqual([24, 5]);
    expect(packets.map((packet) => packet.header.marker)).toEqual([
      false,
      true,
    ]);
    expect(
      depacketized.data.equals(
        Buffer.concat([startCode, sps, startCode, pps, startCode, idr]),
      ),
    ).toBe(true);
  });

  test("rejects H264 packetization-mode other than 1", () => {
    // 実行 / 検証: mode=0 の codec では packetizer を作れない。
    expect(() =>
      createPacketizer({
        codec: useH264({ parameters: "packetization-mode=0" }),
        sourceCodec: "avc",
      }),
    ).toThrow(/packetization-mode=0/);
  });

  test("marks every Opus packet and uses the negotiated payload type", () => {
    const codec = useOPUS();
    codec.payloadType = 111;
    const packetizer = createPacketizer({ codec, sourceCodec: "opus" });

    // 実行: 連続する Opus packet を RTP 化する。
    const packets = createOpusFrames().flatMap((frame, index) =>
      packetizer.packetize(
        new EncodedPacket(frame.data, "key", index * 0.02, 0.02),
        index * 960,
      ),
    );

    // 検証: talkspurt 先頭だけでなく全 packet に marker が立ち、payload は Opus packet そのまま。
    expect(packets.map((packet) => packet.header.marker)).toEqual([
      true,
      true,
      true,
    ]);
    expect(packets.map((packet) => packet.header.payloadType)).toEqual([
      111, 111, 111,
    ]);
    expect(packets[1].payload.equals(createOpusFrames()[1].data)).toBe(true);
  });

  test("packetizes VP8 frames with consecutive sequence numbers", () => {
    const packetizer = createPacketizer({
      codec: useVP8(),
      sourceCodec: "vp8",
    });

    // 実行: keyframe と delta frame を続けて RTP 化する。
    const [key, delta] = createVp8Frames();
    const keyPackets = packetizer.packetize(
      new EncodedPacket(key.data, "key", 0, 1 / 30),
      0,
    );
    const deltaPackets = packetizer.packetize(
      new EncodedPacket(delta.data, "delta", 1 / 30, 1 / 30),
      3_000,
    );

    // 検証: frame を跨いで sequence number が連続し、各 frame が元データへ復元できる。
    expect(deltaPackets[0].header.sequenceNumber).toBe(
      (keyPackets.at(-1)!.header.sequenceNumber + 1) & 0xffff,
    );
    expect(dePacketizeRtpPackets("VP8", keyPackets).data.equals(key.data)).toBe(
      true,
    );
    expect(
      dePacketizeRtpPackets("VP8", deltaPackets).data.equals(delta.data),
    ).toBe(true);
  });
});
