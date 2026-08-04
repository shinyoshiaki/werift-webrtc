import {
  AacHbrPacketizer,
  AacHbrRtpPayload,
  dePacketizeRtpPackets,
} from "../../src";

// RFC 3640 §3.3.6 AAC-hbr: AU-size 13 bit (octets), AU-Index 3 bit
// §3.2.1 AU-headers-length in bits, multiple of 16

describe("packages/rtp/tests/codec/aac.test.ts", () => {
  it("deSerialize single complete AU (synthetic header)", () => {
    // Arrange: AU-headers-length=16, AU-size=3, index=0 → header 0x00 0x10 | 0x00 0x18?
    // size=3 (13 bits) + index=0 (3 bits) = 0b0000000000011_000 = 0x0018
    const auData = Buffer.from([0xaa, 0xbb, 0xcc]);
    const payload = Buffer.concat([
      Buffer.from([0x00, 0x10]), // 16 bits of headers
      Buffer.from([0x00, 0x18]), // size=3, index=0
      auData,
    ]);
    // Act
    const res = AacHbrRtpPayload.deSerialize(payload);
    // Assert
    expect(res.auHeaders[0].size).toBe(3);
    expect(res.payload).toEqual(auData);
  });

  it("packetize/depacketize round-trip for small AU", () => {
    // Arrange
    const au = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const packetizer = new AacHbrPacketizer({ sequenceNumber: 1 });
    // Act
    const packets = packetizer.packetize(au, 48000);
    const frame = dePacketizeRtpPackets("MPEG4-GENERIC", packets);
    // Assert
    expect(packets.length).toBe(1);
    expect(packets[0].header.marker).toBe(true);
    expect(frame.data).toEqual(au);
  });

  it("fragments large AU: first packet has AU header, rest raw", () => {
    // Arrange: AU larger than MTU
    const au = Buffer.alloc(500, 0x5a);
    const packetizer = new AacHbrPacketizer({
      sequenceNumber: 0,
      maxPayloadSize: 100,
    });
    // Act
    const packets = packetizer.packetize(au, 0);
    // Assert: 先頭のみ AU-headers-length を持つ
    expect(packets.length).toBeGreaterThan(1);
    expect(packets[0].payload.readUInt16BE(0)).toBe(16); // 16-bit header section
    // 後続は生データ（先頭 2 バイトが 16 でない可能性が高いが、サイズで確認）
    for (let i = 1; i < packets.length; i++) {
      // continuation has no 2-byte length field matching 16 with size field
      expect(packets[i].payload.length).toBeLessThanOrEqual(100);
    }
    // 最終パケットのみ marker
    expect(packets.at(-1)!.header.marker).toBe(true);
    for (let i = 0; i < packets.length - 1; i++) {
      expect(packets[i].header.marker).toBe(false);
    }
    // シーケンス連番
    expect(packets[1].header.sequenceNumber).toBe(1);

    // Act: デパケタイズで元 AU を復元
    const frame = dePacketizeRtpPackets("MPEG4-GENERIC", packets);
    // Assert
    expect(frame.data).toEqual(au);
  });

  it("rejects invalid AU-headers-length (not multiple of 16)", () => {
    // Arrange: 24 bits is >= 16 but not a multiple of 16
    const bad = Buffer.from([0x00, 0x18, 0x00, 0x00, 0x00]);
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(bad)).toThrow(/multiple of 16/);
  });

  it("rejects AU-headers-length smaller than 16", () => {
    // Arrange
    const bad = Buffer.from([0x00, 0x08, 0x00]);
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(bad)).toThrow(/too small/);
  });

  it("rejects AU sizes that exceed data section for multi-AU", () => {
    // Arrange: claim size=100 but only 2 data bytes; two headers so not fragment path
    // Actually single AU with size>data is fragmentation path. Use two AUs:
    // headers: size1=50 index=0, size2=50 index-delta=0 → 32 bits
    const headers = Buffer.alloc(4);
    // size=50 = 0b00000000110010, index=0 → bits: 00000000110010 000 = need careful packing
    // Easier: size=10 (0x000a << 3 = in 16 bits: size 13 bits = 10, index 3 = 0 → 0x0050)
    // 10 << 3 = 80 = 0x0050
    headers.writeUInt16BE(10 << 3, 0); // first AU size=10
    headers.writeUInt16BE(10 << 3, 2); // second AU size=10
    const payload = Buffer.concat([
      Buffer.from([0x00, 0x20]), // 32 bits
      headers,
      Buffer.from([1, 2, 3]), // only 3 bytes, need 20
    ]);
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(payload)).toThrow(
      /exceed data section/,
    );
  });

  it("packetizeAccessUnits packs multiple AUs when they fit", () => {
    // Arrange
    const aus = [Buffer.from([1, 2]), Buffer.from([3, 4, 5])];
    const packetizer = new AacHbrPacketizer({ sequenceNumber: 0 });
    // Act
    const packets = packetizer.packetizeAccessUnits(aus, 0);
    // Assert: 1 パケットに連結
    expect(packets.length).toBe(1);
    const res = AacHbrRtpPayload.deSerialize(packets[0].payload);
    expect(res.auHeaders.length).toBe(2);
    expect(res.payload).toEqual(Buffer.from([1, 2, 3, 4, 5]));
  });

  it("keeps sequence and timestamp consistent across fragments", () => {
    // Arrange
    const au = Buffer.alloc(250, 0x11);
    const packetizer = new AacHbrPacketizer({
      sequenceNumber: 100,
      maxPayloadSize: 80,
    });
    // Act
    const packets = packetizer.packetize(au, 9999);
    // Assert
    for (const p of packets) {
      expect(p.header.timestamp).toBe(9999);
    }
    expect(packets[0].header.sequenceNumber).toBe(100);
    expect(packets[packets.length - 1].header.sequenceNumber).toBe(
      100 + packets.length - 1,
    );
  });

  // --- wire-format boundary cases (RFC 3640 §3.2.1 / §3.3.6) ---

  it("AU-size is size in octets (not size-1) — RFC 3640 authoritative", () => {
    // Arrange: size field = 5 means 5 data octets (ticket "size-1" was incorrect)
    const auData = Buffer.from([1, 2, 3, 4, 5]);
    // size=5 → (5 << 3) | 0 = 0x0028
    const payload = Buffer.concat([
      Buffer.from([0x00, 0x10]),
      Buffer.from([0x00, 0x28]),
      auData,
    ]);
    // Act
    const res = AacHbrRtpPayload.deSerialize(payload);
    // Assert
    expect(res.auHeaders[0].size).toBe(5);
    expect(res.payload).toEqual(auData);
  });

  it("rejects AU-headers section that claims more bytes than available", () => {
    // Arrange: AU-headers-length=32 bits (4 bytes) but only 1 header byte follows
    const bad = Buffer.from([0x00, 0x20, 0xff]);
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(bad)).toThrow(
      /AU Header Section exceeds buffer/,
    );
  });

  it("rejects surplus data after complete multi-AU payload", () => {
    // Arrange: two AUs size=1 each, but 3 data bytes
    const headers = Buffer.alloc(4);
    headers.writeUInt16BE(1 << 3, 0);
    headers.writeUInt16BE(1 << 3, 2);
    const payload = Buffer.concat([
      Buffer.from([0x00, 0x20]),
      headers,
      Buffer.from([0xaa, 0xbb, 0xcc]),
    ]);
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(payload)).toThrow(/surplus/);
  });

  it("rejects continuation that exceeds declared AU-size", () => {
    // Arrange: first fragment claims size=10, delivers 6 bytes; second delivers 8 → overflow
    const first = Buffer.concat([
      Buffer.from([0x00, 0x10]),
      Buffer.from([0x00, 0x50]), // size=10 (10<<3=80=0x50)
      Buffer.alloc(6, 0x11),
    ]);
    const part1 = AacHbrRtpPayload.deSerialize(first);
    expect(part1.fragment).toBeDefined();
    // Act / Assert: 余剰バイトを切り捨てず例外
    expect(() =>
      AacHbrRtpPayload.deSerialize(Buffer.alloc(8, 0x22), part1.fragment),
    ).toThrow(/exceeds AU-size/);
  });

  it("rejects empty buffer and short AU header length field", () => {
    // Act / Assert
    expect(() => AacHbrRtpPayload.deSerialize(Buffer.alloc(0))).toThrow(
      /too short/,
    );
    expect(() => AacHbrRtpPayload.deSerialize(Buffer.from([0x00]))).toThrow(
      /too short/,
    );
  });

  it("MTU split: marker only on last fragment, shared timestamp", () => {
    // Arrange: AU を MTU 未満に分割
    const au = Buffer.alloc(240, 0x9e);
    const packetizer = new AacHbrPacketizer({
      sequenceNumber: 0,
      maxPayloadSize: 64,
    });
    // Act
    const packets = packetizer.packetize(au, 777);
    // Assert: タイムスタンプ不変、marker は最終のみ
    expect(packets.length).toBeGreaterThan(2);
    expect(packets.every((p) => p.header.timestamp === 777)).toBe(true);
    expect(packets.slice(0, -1).every((p) => !p.header.marker)).toBe(true);
    expect(packets.at(-1)!.header.marker).toBe(true);
    // 先頭のみ AU ヘッダ
    expect(packets[0].payload.readUInt16BE(0)).toBe(16);
    // 復元
    expect(dePacketizeRtpPackets("MPEG4-GENERIC", packets).data).toEqual(au);
  });
});
