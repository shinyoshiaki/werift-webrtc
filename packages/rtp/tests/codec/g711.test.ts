import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  G711_CLOCK_RATE,
  PCMA_PAYLOAD_TYPE,
  PCMU_PAYLOAD_TYPE,
  PcmaPacketizer,
  PcmaRtpPayload,
  PcmuPacketizer,
  PcmuRtpPayload,
  dePacketizeRtpPackets,
} from "../../src";

// RFC 3551 §4.5.14 / Table 4 — PCMU PT=0, PCMA PT=8, clock 8000 Hz

/** Decode [u16be length][payload]... vector files from tools/generateVectors. */
function loadPayloadVector(name: string): Buffer[] {
  const path = join(__dirname, "../data", name);
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const len = buf.readUInt16BE(offset);
    offset += 2;
    out.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return out;
}

describe("packages/rtp/tests/codec/g711.test.ts", () => {
  // Arrange: synthetic G.711 samples (identity for round-trip)
  const samples = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

  it("PCMU static payload type and clock rate constants", () => {
    // Assert: RFC 3551 Table 4
    expect(PCMU_PAYLOAD_TYPE).toBe(0);
    expect(PCMA_PAYLOAD_TYPE).toBe(8);
    expect(G711_CLOCK_RATE).toBe(8000);
  });

  it("PCMU deSerialize returns raw payload", () => {
    // Act: ペイロードをそのままデシリアライズ
    const res = PcmuRtpPayload.deSerialize(samples);
    // Assert: ヘッダ無しの生データ
    expect(res.payload).toEqual(samples);
    expect(res.isKeyframe).toBe(true);
    expect(PcmuRtpPayload.isDetectedFinalPacketInSequence({} as any)).toBe(
      true,
    );
  });

  it("PCMA deSerialize returns raw payload", () => {
    // Act
    const res = PcmaRtpPayload.deSerialize(samples);
    // Assert
    expect(res.payload).toEqual(samples);
  });

  it("PCMU packetize/depacketize round-trip", () => {
    // Arrange
    const packetizer = new PcmuPacketizer({
      sequenceNumber: 1000,
      frameDurationInMs: 20,
    });
    // Act: パケタイズしてからレジストリ経由で復元
    const packets = packetizer.packetize(samples, 0);
    const frame = dePacketizeRtpPackets("PCMU", packets);
    // Assert: ラウンドトリップで一致、静的 PT、シーケンス連番
    expect(frame.data).toEqual(samples);
    expect(packets[0].header.payloadType).toBe(PCMU_PAYLOAD_TYPE);
    expect(packets[0].header.marker).toBe(true);
    expect(packets[0].header.sequenceNumber).toBe(1000);
  });

  it("PCMA packetize uses static PT 8", () => {
    // Arrange / Act
    const packetizer = new PcmaPacketizer({ sequenceNumber: 1 });
    const packets = packetizer.packetize(Buffer.alloc(160, 0xaa), 0);
    // Assert: RFC 3551 PT=8
    expect(packets[0].header.payloadType).toBe(PCMA_PAYLOAD_TYPE);
    expect(packets[0].payload.length).toBe(160);
  });

  it("PCMU splits large buffer by frame duration and advances timestamp", () => {
    // Arrange: 40ms 相当 = 320 バイト @ 8kHz
    const data = Buffer.alloc(320, 0x5a);
    const packetizer = new PcmuPacketizer({
      sequenceNumber: 0,
      frameDurationInMs: 20,
    });
    // Act
    const packets = packetizer.packetize(data, 1000);
    // Assert: 20ms フレーム 2 本、タイムスタンプ +160
    expect(packets.length).toBe(2);
    expect(packets[0].payload.length).toBe(160);
    expect(packets[1].payload.length).toBe(160);
    expect(packets[0].header.timestamp).toBe(1000);
    expect(packets[1].header.timestamp).toBe(1160);
    expect(packets[1].header.sequenceNumber).toBe(1);
  });

  it("respects maxPayloadSize for MTU split", () => {
    // Arrange
    const data = Buffer.alloc(300, 0x01);
    const packetizer = new PcmuPacketizer({
      sequenceNumber: 0,
      maxPayloadSize: 100,
      frameDurationInMs: 1000, // large frame so MTU dominates
    });
    // Act
    const packets = packetizer.packetize(data, 0);
    // Assert: MTU 単位分割
    expect(packets.length).toBe(3);
    expect(packets.every((p) => p.payload.length <= 100)).toBe(true);
  });

  it("PacketizerBase rejects non-positive maxPayloadSize", () => {
    // Act / Assert
    expect(() => new PcmuPacketizer({ maxPayloadSize: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new PcmuPacketizer({ maxPayloadSize: -1 })).toThrow(
      /positive integer/,
    );
  });

  it("MTU split advances timestamp and sets marker on each audio chunk", () => {
    // Arrange: maxPayloadSize がフレームより小さい場合の境界
    const data = Buffer.alloc(250, 0x42);
    const packetizer = new PcmuPacketizer({
      sequenceNumber: 10,
      maxPayloadSize: 100,
      frameDurationInMs: 1000,
    });
    // Act
    const packets = packetizer.packetize(data, 5000);
    // Assert: 各チャンクは完結フレーム扱い (marker=true)、TS はサンプル数分進む
    expect(packets.length).toBe(3);
    expect(packets.every((p) => p.header.marker)).toBe(true);
    expect(packets[0].header.timestamp).toBe(5000);
    expect(packets[1].header.timestamp).toBe(5100);
    expect(packets[2].header.timestamp).toBe(5200);
    expect(packets[0].header.sequenceNumber).toBe(10);
    expect(packets[2].header.sequenceNumber).toBe(12);
    expect(Buffer.concat(packets.map((p) => p.payload))).toEqual(data);
  });

  it("loads committed PCMU vector payloads", () => {
    // Arrange: tools/generateVectors 成果物（合成 or GStreamer）
    const payloads = loadPayloadVector("vector_pcmu.bin");
    // Assert: コミット済みベクタが読める
    expect(payloads.length).toBeGreaterThan(0);
    // Act: 各ペイロードを deSerialize
    for (const p of payloads) {
      const res = PcmuRtpPayload.deSerialize(p);
      expect(res.payload.length).toBe(p.length);
    }
  });

  it("loads committed PCMA vector payloads", () => {
    // Arrange
    const payloads = loadPayloadVector("vector_pcma.bin");
    // Assert
    expect(payloads.length).toBeGreaterThan(0);
    expect(PcmaRtpPayload.deSerialize(payloads[0]).payload).toEqual(
      payloads[0],
    );
  });
});
