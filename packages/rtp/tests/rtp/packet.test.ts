import {
  ExtensionProfiles,
  RtpHeader,
  RtpPacket,
  isPaddingOnlyRtpPacket,
} from "../../src/rtp/rtp";
import { load } from "../utils";
import {
  createPaddingOnlyRtpPacket,
  createRtpWithInvalidPadding,
} from "./rtpTestUtils";

describe("packet", () => {
  test("basic", () => {
    const raw = Buffer.from([
      0x90, 0xe0, 0x69, 0x8f, 0xd9, 0xc2, 0x93, 0xda, 0x1c, 0x64, 0x27, 0x82,
      0x00, 0x01, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff, 0x98, 0x36, 0xbe, 0x88,
      0x9e,
    ]);

    const parsed = RtpPacket.deSerialize(raw);
    expect(parsed.header.version).toBe(2);
    expect(parsed.header.padding).toBe(false);
    expect(parsed.header.extension).toBe(true);
    expect(parsed.header.csrc.length).toBe(0);
    expect(parsed.header.marker).toBe(true);
    expect(parsed.header.sequenceNumber).toBe(27023);
    expect(parsed.header.timestamp).toBe(3653407706);
    expect(parsed.header.ssrc).toBe(476325762);
    expect(parsed.header.extensionProfile).toBe(1);
    expect(parsed.header.extensionLength).toBe(4);
    expect(parsed.header.extensions).toEqual([
      { id: 0, payload: Buffer.from([0xff, 0xff, 0xff, 0xff]) },
    ]);
    expect(parsed.header.payloadOffset).toBe(20);
    expect(parsed.header.payloadType).toBe(96);

    expect(parsed.header.serializeSize).toBe(20);
    expect(parsed.serializeSize).toBe(raw.length);
    const serialized = parsed.serialize();
    expect(serialized).toEqual(raw);
  });

  test("TestRFC8285OneByteExtension", () => {
    const raw = Buffer.from([
      0x90, 0xe0, 0x69, 0x8f, 0xd9, 0xc2, 0x93, 0xda, 0x1c, 0x64, 0x27, 0x82,
      0xbe, 0xde, 0x00, 0x01, 0x50, 0xaa, 0x00, 0x00, 0x98, 0x36, 0xbe, 0x88,
      0x9e,
    ]);
    const p = RtpPacket.deSerialize(raw);
    expect(p.header.extension).toBe(true);
    expect(p.header.extensionProfile).toBe(0xbede);
    expect(p.header.extensions).toEqual([
      { id: 5, payload: Buffer.from([0xaa]) },
    ]);
  });

  test("TestRFC8285OneByteTwoExtensionOfTwoBytes", () => {
    const raw = Buffer.from([
      0x90, 0xe0, 0x69, 0x8f, 0xd9, 0xc2, 0x93, 0xda, 0x1c, 0x64, 0x27, 0x82,
      0xbe, 0xde, 0x00, 0x01, 0x10, 0xaa, 0x20, 0xbb, 0x98, 0x36, 0xbe, 0x88,
      0x9e,
    ]);

    const p = RtpPacket.deSerialize(raw);
    expect(p.header.extensionProfile).toBe(0xbede);
    expect(p.header.extensions).toEqual([
      { id: 1, payload: Buffer.from([0xaa]) },
      { id: 2, payload: Buffer.from([0xbb]) },
    ]);
  });

  test("dtmf", () => {
    const data = load("rtp_dtmf.bin");
    const p = RtpPacket.deSerialize(data);
    const h = p.header;
    expect(h.version).toBe(2);
    expect(h.marker).toBe(true);
    expect(h.payloadType).toBe(101);
    expect(h.sequenceNumber).toBe(24152);
    expect(h.timestamp).toBe(4021352124);
    expect(h.csrc).toEqual([]);
    expect(h.extensions).toEqual([]);
    expect(p.payload.length).toBe(4);
    expect(p.serialize()).toEqual(data);
  });

  test("test_no_ssrc", () => {
    const data = load("rtp.bin");
    const p = RtpPacket.deSerialize(data);
    const h = p.header;
    expect(h.version).toBe(2);
    expect(h.marker).toBe(false);
    expect(h.payloadType).toBe(0);
    expect(h.sequenceNumber).toBe(15743);
    expect(h.timestamp).toBe(3937035252);
    expect(h.csrc).toEqual([]);
    expect(h.extensions).toEqual([]);
    expect(p.payload.length).toBe(160);
    expect(p.serialize()).toEqual(data);
  });

  test("test_padding_only_with_header_extensions", () => {
    const data = load("rtp_only_padding_with_header_extensions.bin");
    const p = RtpPacket.deSerialize(data);
    const h = p.header;
    expect(h.version).toBe(2);
    expect(h.marker).toBe(false);
    expect(h.payloadType).toBe(98);
    expect(h.sequenceNumber).toBe(22138);
    expect(h.timestamp).toBe(3171065731);
    expect(h.csrc).toEqual([]);
    const payload = Buffer.alloc(3);
    payload.writeUIntBE(15846540, 0, 3);
    expect(h.extensions).toEqual([{ id: 2, payload }]);
    expect(h.padding).toBe(true);
    expect(h.paddingSize).toBe(224);
    expect(p.payload.length).toBe(0);
    expect(p.serializeSize).toBe(data.length);
    expect(p.serialize()).toEqual(data);
  });

  test("test_with_csrc", () => {
    const data = load("rtp_with_csrc.bin");
    const p = RtpPacket.deSerialize(data);
    const h = p.header;
    expect(h.version).toBe(2);
    expect(h.marker).toBe(false);
    expect(h.payloadType).toBe(0);
    expect(h.sequenceNumber).toBe(16082);
    expect(h.timestamp).toBe(144);
    expect(h.csrc).toEqual([2882400001, 3735928559]);
    expect(p.header.extensions).toEqual([]);
    expect(p.payload.length).toBe(160);
    const buf = p.serialize();
    expect(buf).toEqual(data);
  });

  test("serialize_deserialize", () => {
    const packet = new RtpPacket(
      new RtpHeader({
        csrc: [],
        csrcLength: 0,
        extension: true,
        extensionProfile: ExtensionProfiles.OneByte,
        extensions: [
          { id: 1, payload: Buffer.from([48]) },
          { id: 2, payload: Buffer.from([40, 1, 222]) },
          { id: 10, payload: Buffer.from([128]) },
        ],
        marker: false,
        padding: false,
        paddingSize: 0,
        payloadType: 109,
        sequenceNumber: 15546,
        ssrc: 2882400001,
        timestamp: 144,
        version: 2,
      }),
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
    const buf = packet.serialize();
    const parsed = RtpPacket.deSerialize(buf);
    const buf2 = parsed.serialize();
    expect(buf2).toEqual(buf);
  });
});

describe("RTP padding-only / malformed padding", () => {
  test("padding-only without extensions roundtrips as empty payload", () => {
    // Arrange: 正規形の padding-only（メディア octet なし）
    const original = createPaddingOnlyRtpPacket({ paddingSize: 16 });

    // Act: serialize してから deSerialize する
    const parsed = RtpPacket.deSerialize(original.serialize());

    // Assert: 受信後は payload が空で paddingSize が残る
    expect(parsed.payload.length).toBe(0);
    expect(parsed.header.padding).toBe(true);
    expect(parsed.header.paddingSize).toBe(16);
    expect(parsed.serializeSize).toBe(original.serialize().length);
    expect(isPaddingOnlyRtpPacket(parsed)).toBe(true);
    expect(parsed.serialize()).toEqual(original.serialize());
  });

  test("padding-only with one-byte header extension roundtrips", () => {
    // Arrange: TWCC 相当の 2 バイト拡張付き probe
    const original = createPaddingOnlyRtpPacket({
      paddingSize: 224,
      extensions: [{ id: 3, payload: Buffer.from([0x00, 0x2a]) }],
    });

    // Act
    const parsed = RtpPacket.deSerialize(original.serialize());

    // Assert
    expect(parsed.payload.length).toBe(0);
    expect(parsed.header.paddingSize).toBe(224);
    expect(parsed.header.extensions[0]?.payload).toEqual(
      Buffer.from([0x00, 0x2a]),
    );
    expect(isPaddingOnlyRtpPacket(parsed)).toBe(true);
  });

  test("rejects padding size 0 without getBit(undefined)", () => {
    // Arrange: P=1 だが末尾 length octet が 0
    const buf = createRtpWithInvalidPadding(0);

    // Act / Assert: RFC 3550 違反として明示的に失敗する
    expect(() => RtpPacket.deSerialize(buf)).toThrow(
      /invalid RTP padding size/,
    );
  });

  test("rejects padding size larger than remaining payload", () => {
    // Arrange: remaining 1 バイトなのに paddingSize=5
    const buf = createRtpWithInvalidPadding(5, 1);

    // Act / Assert
    expect(() => RtpPacket.deSerialize(buf)).toThrow(
      /invalid RTP padding size/,
    );
  });

  test("rejects RTP shorter than the 12-byte header", () => {
    // Arrange: 固定ヘッダ未満
    const buf = Buffer.alloc(11);
    buf[0] = 0x80;

    // Act / Assert: TypeError ではなく短すぎるパケットとして失敗する
    expect(() => RtpPacket.deSerialize(buf)).toThrow(/too short/);
    expect(() => RtpPacket.deSerialize(Buffer.alloc(0))).toThrow(/too short/);
  });

  test("one-byte header extension of length 0 cannot be serialized", () => {
    // Arrange: RFC 8285 one-byte は 1 オクテット未満不可
    const packet = new RtpPacket(
      new RtpHeader({
        extension: true,
        extensionProfile: ExtensionProfiles.OneByte,
        extensions: [{ id: 1, payload: Buffer.alloc(0) }],
        payloadType: 96,
      }),
      Buffer.from([1]),
    );

    // Act / Assert
    expect(() => packet.serialize()).toThrow(/one-byte header extension/);
  });
});
