import {
  appendRfc3550Padding,
  buildSendHeaderExtensions,
  createRtxPaddingPacket,
  hasTwccReceiveTiming,
  isPaddingOnlyRtpPacket,
  PacketResult,
  PacketStatus,
  RedEncoder,
  RTP_EXTENSION_URI,
  RtpContinuity,
  RtpHeader,
  RtpPacket,
  serializeTransportWideCC,
  stampHopByHopExtensions,
  TransportWideSeqUnwrapper,
  TWCC_REFERENCE_TIME_MOD,
  TWCC_REFERENCE_TIME_UNIT_MS,
  TwccReferenceTimeUnwrapper,
} from "../../src";

// 送信側の RTP 部品（webrtc の RTCRtpSender から移したもの）の基本の約束を確かめる。
// 送信経路での組み合わせは packages/webrtc の tests/pbt/sender と tests/pbt/twcc で確かめている。
describe("rtp send path helpers", () => {
  test("RtpContinuity: ソース切替の後の最初のパケットは直前の出力の続き（seq + 1、timestamp + step）になる", () => {
    // Arrange: 入力 seq 100 / ts 1000 を送ったあと、別ソースへの切替を予約する
    const continuity = new RtpContinuity();
    const first = new RtpHeader({ sequenceNumber: 100, timestamp: 1000 });
    continuity.assign(first, 100, 1000);
    continuity.schedule(3000);

    // Act: 新しいソースの入力 seq 7 / ts 50 を送る
    const next = new RtpHeader({ sequenceNumber: 7, timestamp: 50 });
    const rewritten = continuity.assign(next, 7, 50);

    // Assert: 出力は 101 / 4000 に続き、切替が起きたことを返す
    expect(rewritten).toBe(true);
    expect([next.sequenceNumber, next.timestamp]).toEqual([101, 4000]);
    expect(continuity.sequenceNumber).toBe(101);
  });

  test("RedEncoder.serializedLengthWith: push した後の build と同じ長さを返し、encoder を変えない", () => {
    // Arrange: 冗長ブロックを 1 つ持つ encoder
    const encoder = new RedEncoder(1);
    encoder.push({ block: Buffer.alloc(30, 1), timestamp: 0, blockPT: 111 });
    const before = encoder.build().serialize().length;
    const next = { block: Buffer.alloc(40, 2), timestamp: 960, blockPT: 111 };

    // Act: 見積もってから実際に push して build する
    const estimated = encoder.serializedLengthWith(next);
    const unchanged = encoder.build().serialize().length;
    encoder.push(next);

    // Assert: 見積もりは実際の長さと一致し、見積もり自体は encoder を変えない
    expect(unchanged).toBe(before);
    expect(estimated).toBe(encoder.build().serialize().length);
  });

  test("buildSendHeaderExtensions / stampHopByHopExtensions: 転送元の TWCC 値は引き継がず、送信時に新しい TSN を書く", () => {
    // Arrange: MID と TWCC を交渉し、転送元パケットは古い TWCC 値を持つ
    const negotiated = [
      { id: 1, uri: RTP_EXTENSION_URI.sdesMid },
      { id: 3, uri: RTP_EXTENSION_URI.transportWideCC },
    ];
    const original = [{ id: 3, payload: serializeTransportWideCC(9999) }];
    const header = new RtpHeader({ extension: true });

    // Act: 送信用の拡張を組み立て、送信直前に hop-by-hop の値を書く
    header.extensions = buildSendHeaderExtensions(original, negotiated, {
      mid: "0",
    });
    const wideSeq = stampHopByHopExtensions(header, negotiated, {
      twccOn: true,
      allocateTransportWideSequence: () => ({ wire: 5, extended: 65541 }),
      ntpTimestamp: 0n,
    });

    // Assert: id 順に MID と TWCC が並び、TWCC は割り当てた 16-bit 値で、拡張番号を返す
    expect(header.extensions.map((e) => e.id)).toEqual([1, 3]);
    expect(header.extensions[1]!.payload.readUInt16BE(0)).toBe(5);
    expect(wideSeq).toBe(65541);
  });

  test("createRtxPaddingPacket / appendRfc3550Padding: RTX の padding-only パケットになり、末尾に padding 長が入る", () => {
    // Arrange / Act: 200 byte の padding-only パケットと、空 payload への padding
    const packet = createRtxPaddingPacket({
      paddingSize: 200,
      timestamp: 1234,
      payloadType: 97,
      ssrc: 0x1234,
    });
    const padded = appendRfc3550Padding(Buffer.alloc(0), 200);

    // Assert: padding-only と判定され、RTX の PT / SSRC を持ち、padding の最終 octet が長さ
    expect(isPaddingOnlyRtpPacket(packet)).toBe(true);
    expect([packet.header.payloadType, packet.header.ssrc]).toEqual([
      97, 0x1234,
    ]);
    expect(padded).toHaveLength(200);
    expect(padded[199]).toBe(200);
    expect(() => appendRfc3550Padding(Buffer.alloc(0), 256)).toThrow();
    expect(RtpPacket.deSerialize(packet.serialize()).header.padding).toBe(true);
  });

  test("TwccReferenceTimeUnwrapper: 24-bit の周回をまたいでも時刻は連続して進む", () => {
    // Arrange: 周回直前の reference_time
    const unwrapper = new TwccReferenceTimeUnwrapper();
    const beforeWrap = unwrapper.unwrapBaseMs(TWCC_REFERENCE_TIME_MOD - 1);

    // Act: 周回後の 0
    const afterWrap = unwrapper.unwrapBaseMs(0);

    // Assert: 64 ms だけ進む（約 12 日戻らない）
    expect(afterWrap - beforeWrap).toBe(TWCC_REFERENCE_TIME_UNIT_MS);
  });

  test("hasTwccReceiveTiming: ReceivedWithoutDelta は受信だが時刻サンプルにしない", () => {
    // Arrange: delta なしの受信と、時刻 0 の small delta
    const withoutDelta = new PacketResult({
      received: true,
      status: PacketStatus.TypeTCCPacketReceivedWithoutDelta,
      receivedAtMs: 0,
    });
    const smallDelta = new PacketResult({
      received: true,
      status: PacketStatus.TypeTCCPacketReceivedSmallDelta,
      receivedAtMs: 0,
    });

    // Act / Assert: 時刻 0 でも small delta はサンプル、delta なしはサンプルではない
    expect(hasTwccReceiveTiming(withoutDelta)).toBe(false);
    expect(hasTwccReceiveTiming(smallDelta)).toBe(true);
  });

  test("TransportWideSeqUnwrapper: 送信時の拡張番号はそのまま保ち、基準は前にしか進まない", () => {
    // Arrange
    const unwrapper = new TransportWideSeqUnwrapper();

    // Act: 周回をまたいで順序外に記録する
    const values = [65535, 65537, 65536].map((s) => unwrapper.advanceSent(s));

    // Assert: 値は入力どおりで、最新は最大の 65537
    expect(values).toEqual([65535, 65537, 65536]);
    expect(unwrapper.last).toBe(65537);
  });
});
