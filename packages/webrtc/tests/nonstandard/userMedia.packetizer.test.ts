import { EncodedPacket } from "mediabunny";

import {
  AV1RtpPayload,
  Vp8RtpPayload,
  dePacketizeRtpPackets,
  useAV1X,
  useVP8,
  useVP9,
} from "../../src";
import {
  Vp8Packetizer,
  createPacketizer,
} from "../../src/nonstandard/userMedia/packetizer";
import { createVp8EncodedPacket } from "./userMediaTestUtils";

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
    const packetizer = new Vp8Packetizer(useVP8(), { pictureId: 0x03d7 });

    // 実行: 3 packet 以上に断片化される VP8 フレームを RTP 化する。
    const packets = packetizer.packetize(packet, 90_000);
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
    const packetizer = new Vp8Packetizer(useVP8(), { pictureId: 0x7ffe });
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
        .packetize(packet, index * 3_000)
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
});
