import { EncodedPacket } from "mediabunny";

import {
  AV1RtpPayload,
  dePacketizeRtpPackets,
  useAV1X,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from "../../src";
import { createPacketizer } from "../../src/nonstandard/userMedia/packetizer";
import {
  createAv1TemporalUnitWithSequenceHeader,
  createH264DecoderDescription,
  createOpusFrames,
  createVp8Frames,
  h264TestNalUnits,
  toAvccSample,
} from "./userMediaTestUtils";

describe("nonstandard/userMedia packetizer", () => {
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
