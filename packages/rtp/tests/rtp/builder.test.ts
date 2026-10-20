import { RtpHeader, RtpPacket } from "../../src/rtp/rtp";
import { RtpBuilder } from "../../src/util";
import { createManualMediaClockHarness } from "../utils";

describe("rtp/RtpBuilder", () => {
  const payload = Buffer.from([1, 2, 3]);

  test("between モードの出力は従来と同じ", () => {
    // Arrange: 従来どおり between / clockRate のみ指定
    const builder = new RtpBuilder({ between: 20, clockRate: 48_000 });
    let expectedSeq = builder.sequenceNumber;
    let expectedTs = builder.timestamp;

    for (let i = 0; i < 5; i++) {
      // Act: create() を繰り返す
      const rtp = builder.create(payload);

      // Assert: 初回から先に加算し、seq +1 / ts +960、PT=96 / ext=true / marker=false
      expectedSeq = (expectedSeq + 1) & 0xffff;
      expectedTs = (expectedTs + 960) % 2 ** 32;
      const expected = new RtpPacket(
        new RtpHeader({
          sequenceNumber: expectedSeq,
          timestamp: expectedTs,
          payloadType: 96,
          extension: true,
          marker: false,
          padding: false,
        }),
        payload,
      );
      expect(rtp.serialize().equals(expected.serialize())).toBe(true);
      expect(rtp.header.ssrc).toBe(0);
    }
  });

  test("小数の増分でも例外にならず、長時間でも誤差が溜まらない", () => {
    // Arrange: 44.1kHz / 10.5ms (= 463.05 samples/packet)
    const builder = new RtpBuilder({
      between: 10.5,
      clockRate: 44_100,
      initialTimestamp: 0,
      initialSequenceNumber: 0,
    });
    const oneHourPackets = Math.floor(3_600_000 / 10.5);

    // Act: 1 時間分 create() する
    let rtp: RtpPacket | undefined;
    for (let i = 0; i < oneHourPackets; i++) {
      rtp = builder.create(payload);
    }

    // Assert: 厳密値 N * 46305 / 100 との差は丸めの 1 sample 以内
    const exact = (oneHourPackets * 46305) / 100;
    expect(Math.abs(rtp!.header.timestamp - exact)).toBeLessThanOrEqual(1);
    expect(rtp!.header.timestamp).toBe(Math.round(exact));
  });

  test("PT / SSRC / marker / extension を指定できる", () => {
    // Arrange
    const builder = new RtpBuilder({
      payloadType: 111,
      ssrc: 0x12345678,
      marker: true,
      extension: false,
      initialTimestamp: 5000,
      initialSequenceNumber: 10,
    });

    // Act: 既定 marker と create 時の上書き
    const first = builder.create(payload);
    const second = builder.create(payload, { marker: false });

    // Assert
    expect(first.header).toMatchObject({
      payloadType: 111,
      ssrc: 0x12345678,
      marker: true,
      extension: false,
      sequenceNumber: 10,
      timestamp: 5000,
    });
    expect(second.header.marker).toBe(false);
    expect(second.header.sequenceNumber).toBe(11);
  });

  test("sequence number は 16-bit で wrap する", () => {
    // Arrange: initialSequenceNumber = 0xffff
    const builder = new RtpBuilder({
      between: 20,
      clockRate: 48_000,
      initialSequenceNumber: 0xffff,
    });

    // Act
    const seqs = [0, 1, 2].map(
      () => builder.create(payload).header.sequenceNumber,
    );

    // Assert: 65535 → 0 → 1
    expect(seqs).toEqual([0xffff, 0, 1]);
  });

  test("timestamp は 32-bit で wrap する", () => {
    // Arrange: wrap 直前から開始
    const builder = new RtpBuilder({
      between: 20,
      clockRate: 48_000,
      initialTimestamp: 0xffffffff - 100,
    });

    // Act
    const timestamps = [0, 1].map(
      () => builder.create(payload).header.timestamp,
    );

    // Assert: 0xffffffff - 100 + 960 は wrap して 859
    expect(timestamps).toEqual([859, 1819]);
  });

  test("elapsedSamples: 0 で同一 timestamp の複数パケット (video) を作れる", () => {
    // Arrange: 90kHz / 30fps
    const builder = new RtpBuilder({
      clockRate: 90_000,
      initialTimestamp: 0,
      initialSequenceNumber: 0,
    });

    // Act: 1 フレーム目 3 パケット、2 フレーム目 2 パケット
    const packets = [
      builder.create(payload, { elapsedSamples: 0 }),
      builder.create(payload, { elapsedSamples: 0 }),
      builder.create(payload, { elapsedSamples: 0, marker: true }),
      builder.create(payload, { elapsedSamples: 3000 }),
      builder.create(payload, { elapsedSamples: 0, marker: true }),
    ];

    // Assert: seq はパケットごと、timestamp はフレームごとに進む
    expect(packets.map((p) => p.header.sequenceNumber)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(packets.map((p) => p.header.timestamp)).toEqual([
      0, 0, 0, 3000, 3000,
    ]);
    expect(packets.map((p) => p.header.marker)).toEqual([
      false,
      false,
      true,
      false,
      true,
    ]);
  });

  test("advanceSamples は timestamp だけを進める", () => {
    // Arrange
    const builder = new RtpBuilder({
      initialTimestamp: 1000,
      initialSequenceNumber: 7,
    });

    // Act: skip 分を advanceSamples で表現してから送る
    builder.advanceSamples(960 * 3);
    const rtp = builder.create(payload);

    // Assert: seq は 1 つだけ、timestamp は 3 フレーム分進む
    expect(rtp.header.sequenceNumber).toBe(7);
    expect(rtp.header.timestamp).toBe(1000 + 2880);
  });

  test("timestamp 絶対指定でアプリ所有の timeline (relay) を保持する", () => {
    // Arrange
    const builder = new RtpBuilder({
      between: 20,
      clockRate: 48_000,
      initialSequenceNumber: 0,
    });

    // Act: リモート由来の不規則な timestamp をそのまま指定する
    const timestamps = [123456, 124416, 130000, 0xfffffff0].map(
      (timestamp) => builder.create(payload, { timestamp }).header.timestamp,
    );
    // between 指定時は以降の create() がその値から再開する
    const next = builder.create(payload);

    // Assert
    expect(timestamps).toEqual([123456, 124416, 130000, 0xfffffff0]);
    expect(next.header.timestamp).toBe((0xfffffff0 + 960) % 2 ** 32);
    expect(next.header.sequenceNumber).toBe(4);
  });

  test("timeline オプションの同時指定はエラー", () => {
    // Arrange
    const builder = new RtpBuilder({});

    // Act / Assert: elapsedSamples と timestamp の同時指定は拒否する
    expect(() =>
      builder.create(payload, { elapsedSamples: 0, timestamp: 1 }),
    ).toThrow(TypeError);
  });

  test("tick 連携: seq は送出分だけ、timestamp はメディア timeline どおり進む", () => {
    // Arrange: 48kHz/20ms クロックと seq=100 から始まる builder
    const harness = createManualMediaClockHarness();
    const clock = harness.createClock({
      clockRate: 48_000,
      frameSamples: 960,
      initialTimestamp: 0,
    });
    const builder = new RtpBuilder({ initialSequenceNumber: 100 });
    const sent: RtpPacket[] = [];
    clock.onTick.subscribe((tick) => {
      // frame 50 (ts=48000) 以降だけ送出する
      if (tick.frameIndex >= 50) {
        sent.push(builder.create(payload, { tick }));
      }
    });
    clock.start();
    harness.advance(1000);

    // Act: ts=48000 送出直後に 5 秒ストールさせる
    harness.block(5000);
    harness.advance(0);

    // Assert: seq は 100 → 101 と送出分だけ、ts は 48000 → 288000 とギャップを含む
    expect(sent.map((p) => p.header.sequenceNumber)).toEqual([100, 101]);
    expect(sent.map((p) => p.header.timestamp)).toEqual([48000, 288000]);
    clock.stop();
  });

  test("clock 指定時は create() がクロックの最新 tick の timestamp を使う", () => {
    // Arrange
    const harness = createManualMediaClockHarness();
    const clock = harness.createClock({
      clockRate: 90_000,
      frameDurationMs: 1001 / 30,
      initialTimestamp: 0,
    });
    const builder = new RtpBuilder({ clock, initialSequenceNumber: 0 });
    const sent: RtpPacket[] = [];
    clock.onTick.subscribe(() => {
      // 1 フレームを 2 パケットに分割して送る
      sent.push(builder.create(payload));
      sent.push(builder.create(payload, { marker: true }));
    });

    // Act: 3 フレーム分動かす
    clock.start();
    harness.advance(70);
    clock.stop();

    // Assert: 29.97fps (30000/1001) の 3003 samples 刻みで、同一フレームは timestamp を共有する
    expect(sent.map((p) => p.header.timestamp)).toEqual([
      0, 0, 3003, 3003, 6006, 6006,
    ]);
    expect(sent.map((p) => p.header.sequenceNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });
});
