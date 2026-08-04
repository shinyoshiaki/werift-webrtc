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
});
