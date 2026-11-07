import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  RtpHeader,
  RtpPacket,
  Vp8Packetizer,
  Vp8RtpPayload,
  createVp8PayloadDescriptor,
  dePacketizeRtpPackets,
} from "../../src";
import { createVp8Frame, createVp8Payload, loadPayloadVector } from "../utils";

// RFC 7741 §4.2 descriptor (X/I/M + 15-bit PictureID), §4.3 payload header P bit (keyframe)

/** Minimal VP8 frame: P=0 (key) in first byte of payload header. */
const makeVp8Keyframe = (bodyLen = 20) =>
  createVp8Frame({ keyframe: true, bodyLen });

/** Inter frame: P=1 (LSB set). */
const makeVp8Delta = (bodyLen = 20) =>
  createVp8Frame({ keyframe: false, bodyLen });

describe("packages/rtp/tests/codec/vp8.test.ts", () => {
  it("descriptor: X=1 I=1 M=1 with PictureID; first packet S=1 (0x90), continuation S=0 (0x80)", () => {
    // Arrange: MTU より大きいフレームで複数パケット化
    const frame = makeVp8Keyframe(100);
    const packetizer = new Vp8Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 40,
      pictureId: 0x1234,
    });
    // Act
    const packets = packetizer.packetize(frame, 90000);
    // Assert: RFC 7741 §4.2 — 先頭 S=1 PID=0、継続 S=0、全断片で同じ PictureID
    expect(packets.length).toBeGreaterThan(1);
    expect([...packets[0].payload.subarray(0, 4)]).toEqual([
      0x90, 0x80, 0x92, 0x34,
    ]);
    for (let i = 1; i < packets.length; i++) {
      expect([...packets[i].payload.subarray(0, 4)]).toEqual([
        0x80, 0x80, 0x92, 0x34,
      ]);
    }
    for (const packet of packets) {
      // 各 payload が maxPayloadSize 以下で、L/T/K 拡張は付かない
      expect(packet.payload.length).toBeLessThanOrEqual(40);
      const parsed = Vp8RtpPayload.deSerialize(packet.payload);
      expect(parsed.xBit).toBe(1);
      expect(parsed.iBit).toBe(1);
      expect(parsed.mBit).toBe(1);
      expect(parsed.lBit).toBe(0);
      expect(parsed.tBit).toBe(0);
      expect(parsed.kBit).toBe(0);
      expect(parsed.pictureId).toBe(0x1234);
    }
    // 最終のみ marker
    expect(packets.at(-1)!.header.marker).toBe(true);
    for (let i = 0; i < packets.length - 1; i++) {
      expect(packets[i].header.marker).toBe(false);
    }
  });

  it("increments PictureID per frame and wraps 0x7fff -> 0", () => {
    // Arrange: wrap 直前の PictureID から開始
    const packetizer = new Vp8Packetizer({
      sequenceNumber: 1,
      maxPayloadSize: 40,
      pictureId: 0x7ffe,
    });
    // Act: 3 フレーム連続で packetize
    const frames = [0, 1, 2].map((i) =>
      packetizer.packetize(makeVp8Delta(60), i * 3000),
    );
    // Assert: フレームごとに +1 し、0x7fff の次は 0。同一フレーム内は同値
    const ids = frames.map((packets) => {
      const set = new Set(
        packets.map((p) => Vp8RtpPayload.deSerialize(p.payload).pictureId),
      );
      expect(set.size).toBe(1);
      return [...set][0];
    });
    expect(ids).toEqual([0x7ffe, 0x7fff, 0]);
  });

  it("starts from a random 15-bit PictureID by default", () => {
    // Act
    const packets = new Vp8Packetizer().packetize(makeVp8Keyframe(10), 0);
    const parsed = Vp8RtpPayload.deSerialize(packets[0].payload);
    // Assert: 15 bit 範囲の値
    expect(parsed.pictureId).toBeGreaterThanOrEqual(0);
    expect(parsed.pictureId).toBeLessThanOrEqual(0x7fff);
  });

  it("createVp8PayloadDescriptor masks PictureID to 15 bits", () => {
    // Act
    const start = createVp8PayloadDescriptor({ start: true, pictureId: 0 });
    const cont = createVp8PayloadDescriptor({
      start: false,
      pictureId: 0x8001,
    });
    // Assert
    expect([...start]).toEqual([0x90, 0x80, 0x80, 0x00]);
    expect([...cont]).toEqual([0x80, 0x80, 0x80, 0x01]);
  });

  it("round-trips frame via dePacketizeRtpPackets", () => {
    // Arrange
    const frame = makeVp8Keyframe(1500);
    const packetizer = new Vp8Packetizer({ sequenceNumber: 10 });
    // Act: フラグメントしてから復元
    const packets = packetizer.packetize(frame, 90000);
    const depacketized = dePacketizeRtpPackets("VP8", packets);
    // Assert: descriptor 除去後の連結が元フレーム
    expect(packets.length).toBeGreaterThan(1);
    expect(depacketized.data.equals(frame)).toBe(true);
    for (const packet of packets) {
      // 既定 maxPayloadSize (1200) を超えない
      expect(packet.payload.length).toBeLessThanOrEqual(1200);
    }
  });

  it("detects keyframe from P bit on first packet (RFC 7741 §4.3)", () => {
    // Arrange
    const key = makeVp8Keyframe(10);
    const delta = makeVp8Delta(10);
    const packetizer = new Vp8Packetizer({ sequenceNumber: 1 });
    // Act
    const keyPkts = packetizer.packetize(key, 0);
    const deltaPkts = new Vp8Packetizer({ sequenceNumber: 2 }).packetize(
      delta,
      0,
    );
    const keyPayload = Vp8RtpPayload.deSerialize(keyPkts[0].payload);
    const deltaPayload = Vp8RtpPayload.deSerialize(deltaPkts[0].payload);
    // Assert: P=0 → keyframe, P=1 → not
    expect(keyPayload.sBit).toBe(1);
    expect(keyPayload.pid).toBe(0);
    expect(keyPayload.isKeyframe).toBe(true);
    expect(deltaPayload.isKeyframe).toBe(false);
    expect(dePacketizeRtpPackets("VP8", keyPkts).isKeyframe).toBe(true);
  });

  it("rejects maxPayloadSize too small for descriptor", () => {
    // Act / Assert
    expect(() =>
      new Vp8Packetizer({ maxPayloadSize: 4 }).packetize(
        Buffer.from([0x00, 0x00, 0x00]),
        0,
      ),
    ).toThrow(/too small/);
  });

  it("returns empty for empty frame", () => {
    // Act
    const packets = new Vp8Packetizer().packetize(Buffer.alloc(0), 0);
    // Assert
    expect(packets).toEqual([]);
  });

  it("loads committed VP8 vector (GStreamer rtpvp8pay) and matches expected", () => {
    // Arrange: tools/generateVectors 成果物
    const path = join(__dirname, "../data/vector_vp8.bin");
    expect(existsSync(path)).toBe(true);
    const payloads = loadPayloadVector("vector_vp8.bin");
    const expected = readFileSync(
      join(__dirname, "../data/vector_vp8_expected.bin"),
    );
    // Act: descriptor 除去して連結
    expect(payloads.length).toBeGreaterThan(0);
    const restored = Buffer.concat(
      payloads.map((p) => Vp8RtpPayload.deSerialize(p).payload),
    );
    // Assert: expected と一致、descriptor が剥がれている
    expect(restored).toEqual(expected);
    expect(restored.length).toBeGreaterThan(0);
    // 先頭パケットは S=1 のパーティション開始
    const first = Vp8RtpPayload.deSerialize(payloads[0]);
    expect(first.sBit).toBe(1);
  });

  describe("Vp8RtpPayload.deSerialize descriptor extensions (RFC 7741 §4.2)", () => {
    // TID/Y/KEYIDX オクテットは LSB=1 にしておく。誤って payload header として
    // 読まれると P=1 (delta) と判定され、offset ずれを検出できる。
    it("T=1, L=0, K=0: skips TID/Y/KEYIDX octet", () => {
      // Arrange: X=1 / T=1 のみ、TID=1 Y=0 KEYIDX=1
      const frame = createVp8Frame({ keyframe: true });
      const buf = createVp8Payload({
        descriptor: [0x90, 0x20, 0x41],
        frame,
      });
      // Act: T=1 のみの descriptor を解析
      const p = Vp8RtpPayload.deSerialize(buf);
      // Assert: TID/Y/KEYIDX の 1 オクテットを飛ばして payload header から読むこと
      expect(p.lBit).toBe(0);
      expect(p.tBit).toBe(1);
      expect(p.kBit).toBe(0);
      expect(p.payload.equals(frame)).toBe(true);
      // Assert: payload header の P=0 を読み keyframe と判定すること
      expect(p.isKeyframe).toBe(true);
      expect([p.size0, p.size1, p.size2]).toEqual([0, 0, 0]);
    });

    it("K=1, L=0, T=0: skips TID/Y/KEYIDX octet", () => {
      // Arrange: X=1 / K=1 のみ、KEYIDX=1
      const frame = createVp8Frame({ keyframe: true });
      const buf = createVp8Payload({
        descriptor: [0x90, 0x10, 0x01],
        frame,
      });
      // Act: K=1 のみの descriptor を解析
      const p = Vp8RtpPayload.deSerialize(buf);
      // Assert: TID/Y/KEYIDX を飛ばし、payload 先頭が元フレームと一致すること
      expect(p.kBit).toBe(1);
      expect(p.tBit).toBe(0);
      expect(p.payload.equals(frame)).toBe(true);
      // Assert: keyframe と判定すること
      expect(p.isKeyframe).toBe(true);
    });

    it("I=1 M=1 L=1 T=1 (browser temporal layers): skips PictureID, TL0PICIDX and TID/Y/KEYIDX", () => {
      // Arrange: PictureID=0x1234、TL0PICIDX=0x05、TID=1 KEYIDX=1
      const frame = createVp8Frame({ keyframe: true });
      const buf = createVp8Payload({
        descriptor: [0x90, 0xe0, 0x92, 0x34, 0x05, 0x41],
        frame,
      });
      // Act: L/T 付き descriptor を解析
      const p = Vp8RtpPayload.deSerialize(buf);
      // Assert: 15bit PictureID を読み、計 6 バイトの descriptor を飛ばすこと
      expect(p.pictureId).toBe(0x1234);
      expect(p.lBit).toBe(1);
      expect(p.tBit).toBe(1);
      expect(p.payload.length).toBe(buf.length - 6);
      expect(p.payload.equals(frame)).toBe(true);
      // Assert: keyframe と判定すること
      expect(p.isKeyframe).toBe(true);
    });

    it("I=1 M=1 only (werift packetizer format): skips 4-byte descriptor", () => {
      // Arrange: werift の送信形式 (X/I/M、L/T/K=0)
      const frame = createVp8Frame({ keyframe: false });
      const buf = createVp8Payload({
        descriptor: [0x90, 0x80, 0x92, 0x34],
        frame,
      });
      // Act: X/I/M のみの descriptor を解析
      const p = Vp8RtpPayload.deSerialize(buf);
      // Assert: L/T/K は 0 で、PictureID の後ろから payload が始まること
      expect([p.lBit, p.tBit, p.kBit]).toEqual([0, 0, 0]);
      expect(p.payload.equals(frame)).toBe(true);
      // Assert: P=1 の delta frame と判定すること
      expect(p.isKeyframe).toBe(false);
    });

    it("L=1, T=0, K=0 (violates RFC): consumes only TL0PICIDX", () => {
      // Arrange: RFC 違反の L=1 / T=0。後続は delta frame
      const frame = createVp8Frame({ keyframe: false });
      const buf = createVp8Payload({
        descriptor: [0x90, 0x40, 0x05],
        frame,
      });
      // Act: 例外にせず bit どおりに解析
      const p = Vp8RtpPayload.deSerialize(buf);
      // Assert: TL0PICIDX のみ飛ばし、payload header の 1 バイト目を残すこと
      expect(p.lBit).toBe(1);
      expect(p.tBit).toBe(0);
      expect(p.payload.equals(frame)).toBe(true);
      // Assert: Size1 ではなく payload header の P=1 を読み delta と判定すること
      expect(p.isKeyframe).toBe(false);
    });

    it("dePacketizeRtpPackets restores frame and keyframe flag with T=1 descriptor", () => {
      // Arrange: T=1 のみの descriptor を付けた単一 RTP パケット
      const frame = createVp8Frame({ keyframe: true, bodyLen: 50 });
      const packet = new RtpPacket(
        new RtpHeader({ payloadType: 96, sequenceNumber: 1, marker: true }),
        createVp8Payload({ descriptor: [0x90, 0x20, 0x41], frame }),
      );
      // Act: depacketize
      const depacketized = dePacketizeRtpPackets("VP8", [packet]);
      // Assert: descriptor を除いたデータが元フレームと一致し、keyframe と判定すること
      expect(depacketized.data.equals(frame)).toBe(true);
      expect(depacketized.isKeyframe).toBe(true);
    });
  });
});
