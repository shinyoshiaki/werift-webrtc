import { EncodedPacket } from "mediabunny";

import {
  AV1RtpPayload,
  dePacketizeRtpPackets,
  useAV1X,
  useVP9,
} from "../../src";
import { createPacketizer } from "../../src/nonstandard/userMedia/packetizer";

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
});
