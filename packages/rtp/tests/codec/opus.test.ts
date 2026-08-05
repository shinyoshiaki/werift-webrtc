import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  OPUS_CLOCK_RATE,
  OpusPacketizer,
  OpusRtpPayload,
  dePacketizeRtpPackets,
} from "../../src";
import { loadPayloadVector } from "../utils";

// RFC 7587 — Opus RTP: raw payload, no codec header; one packet = one Opus packet

describe("packages/rtp/tests/codec/opus.test.ts", () => {
  it("exports OPUS_CLOCK_RATE 48000 (RFC 7587 §4)", () => {
    // Assert: デフォルトクロックは 48000 Hz
    expect(OPUS_CLOCK_RATE).toBe(48000);
  });

  it("deSerialize returns raw payload and is always final", () => {
    // Arrange
    const samples = Buffer.from([0xfc, 0x00, 0x01, 0x02]);
    // Act
    const res = OpusRtpPayload.deSerialize(samples);
    // Assert: ヘッダ無しの生データ
    expect(res.payload).toEqual(samples);
    expect(res.isKeyframe).toBe(true);
    expect(OpusRtpPayload.isDetectedFinalPacketInSequence({} as any)).toBe(
      true,
    );
  });

  it("packetize single Opus packet with marker and round-trips", () => {
    // Arrange: 合成 Opus パケット（TOC + フレーム）
    const opusPacket = Buffer.from([0xfc, 0xaa, 0xbb, 0xcc, 0xdd]);
    const packetizer = new OpusPacketizer({
      sequenceNumber: 42,
      payloadType: 111,
    });
    // Act: 1 RTP に載せ、レジストリ経由で復元
    const packets = packetizer.packetize(opusPacket, 48000);
    const frame = dePacketizeRtpPackets("OPUS", packets);
    // Assert: 単一パケット・marker=true・PT/seq 維持・往復一致
    expect(packets.length).toBe(1);
    expect(packets[0].header.marker).toBe(true);
    expect(packets[0].header.payloadType).toBe(111);
    expect(packets[0].header.sequenceNumber).toBe(42);
    expect(packets[0].header.timestamp).toBe(48000);
    expect(frame.data).toEqual(opusPacket);
  });

  it("rejects Opus packets larger than maxPayloadSize (no TOC split)", () => {
    // Arrange: MTU 超過の Opus パケット
    const tooBig = Buffer.alloc(100, 0x11);
    const packetizer = new OpusPacketizer({ maxPayloadSize: 50 });
    // Act / Assert: TOC を壊す分割は禁止
    expect(() => packetizer.packetize(tooBig, 0)).toThrow(/maxPayloadSize/);
  });

  it("returns empty array for empty input", () => {
    // Act
    const packets = new OpusPacketizer().packetize(Buffer.alloc(0), 0);
    // Assert
    expect(packets).toEqual([]);
  });

  it("loads committed Opus vector (GStreamer rtpopuspay) and matches expected", () => {
    // Arrange
    const path = join(__dirname, "../data/vector_opus.bin");
    expect(existsSync(path)).toBe(true);
    const payloads = loadPayloadVector("vector_opus.bin");
    const expected = readFileSync(
      join(__dirname, "../data/vector_opus_expected.bin"),
    );
    // Act: 生ペイロード連結 = Opus パケット列
    expect(payloads.length).toBeGreaterThan(0);
    const restored = Buffer.concat(
      payloads.map((p) => OpusRtpPayload.deSerialize(p).payload),
    );
    // Assert
    expect(restored).toEqual(expected);
    expect(restored.length).toBeGreaterThan(0);
  });
});
