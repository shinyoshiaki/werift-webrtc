import {
  RtpTimelineRewriter,
  type RtpTimelineSwitch,
  SrtpReplayError,
} from "../../src";
import {
  createManualClock,
  createMediaRtpPacket,
  createPaddingOnlyRtpPacket,
  createSrtpSessionPair,
} from "./rtpTestUtils";

/** [seq, ts] of each output; undefined for a dropped packet. */
const seqTs = (rewriter: RtpTimelineRewriter, input: [number, number][]) =>
  input.map(([seq, ts]) => {
    const out = rewriter.rewrite(createMediaRtpPacket(seq, ts));
    return out && [out.header.sequenceNumber, out.header.timestamp];
  });

describe("RtpTimelineRewriter", () => {
  test("最初のソースは seq / timestamp をそのまま出力し、ssrc / payloadType 固定オプションはその値だけ書き換える", () => {
    // Arrange: 出力 SSRC と PT を固定する
    const rewriter = new RtpTimelineRewriter({ ssrc: 0xabcd, payloadType: 99 });

    // Act: 最初のソースのパケットを書き換える
    const out = rewriter.rewrite(createMediaRtpPacket(500, 123456))!;

    // Assert: seq / timestamp は入力のまま、SSRC と PT だけ固定値になる
    expect(out.header.sequenceNumber).toBe(500);
    expect(out.header.timestamp).toBe(123456);
    expect(out.header.ssrc).toBe(0xabcd);
    expect(out.header.payloadType).toBe(99);
    expect(rewriter.sequenceNumber).toBe(500);
    expect(rewriter.timestamp).toBe(123456);
  });

  test("入力パケットは変更せず clone を返す（inPlace のときは同じパケットを書き換える）", () => {
    // Arrange: 1 つ目のソースを流してから別ソースへ切り替える
    const rewriter = new RtpTimelineRewriter({ ssrc: 7, timestampStep: 10 });
    rewriter.rewrite(createMediaRtpPacket(10, 100), { source: 1 });
    const input = createMediaRtpPacket(900, 9000);
    const inPlace = new RtpTimelineRewriter({ inPlace: true, ssrc: 7 });
    const shared = createMediaRtpPacket(1, 2);

    // Act: 新ソースのパケットを書き換える
    const out = rewriter.rewrite(input, { source: 2 })!;
    const inPlaceOut = inPlace.rewrite(shared)!;

    // Assert: 出力は別オブジェクトで、入力の header は元の値のまま
    expect(out).not.toBe(input);
    expect([out.header.sequenceNumber, out.header.timestamp]).toEqual([
      11, 110,
    ]);
    expect(input.header.sequenceNumber).toBe(900);
    expect(input.header.timestamp).toBe(9000);
    expect(input.header.ssrc).toBe(1111);
    // Assert: inPlace では渡したパケットそのものが書き換わる
    expect(inPlaceOut).toBe(shared);
    expect(shared.header.ssrc).toBe(7);
  });

  test("同じソース内の順序入れ替わりと欠落は相対関係を保つ", () => {
    // Arrange: 1 つ目のソースの後、固定 step 3000 で 2 つ目へ切り替える
    const rewriter = new RtpTimelineRewriter({ timestampStep: 3000 });
    seqTs(rewriter, [[1000, 90000]]);
    rewriter.switchSource();

    // Act: 新ソースで 10, 12, 11（入れ替わり）, 15（13, 14 欠落）を流す
    const out = seqTs(rewriter, [
      [10, 500],
      [12, 6500],
      [11, 3500],
      [15, 15500],
    ]);

    // Assert: 入力と同じ差分のまま 1001 起点に写像される
    expect(out).toEqual([
      [1001, 93000],
      [1003, 99000],
      [1002, 96000],
      [1006, 108000],
    ]);
  });

  test("固定 step: 切替後の最初のパケットは seq + 1 / ts + step になり、onSourceSwitch で通知される", () => {
    // Arrange: 固定 step 3000 で、切替通知を記録する
    const rewriter = new RtpTimelineRewriter({ timestampStep: 3000 });
    const switches: RtpTimelineSwitch[] = [];
    rewriter.onSourceSwitch.subscribe((s) => switches.push(s));
    rewriter.rewrite(createMediaRtpPacket(40000, 90000), { source: "a" });

    // Act: 別の source キーのパケットを流す
    const out = rewriter.rewrite(createMediaRtpPacket(7, 1, { ssrc: 2222 }), {
      source: "b",
    })!;

    // Assert: 40001 / 93000 に続き、切替内容が通知される
    expect([out.header.sequenceNumber, out.header.timestamp]).toEqual([
      40001, 93000,
    ]);
    expect(switches).toEqual([
      {
        source: "b",
        inputSsrc: 2222,
        sequenceNumber: 40001,
        timestamp: 93000,
        timestampStep: 3000,
      },
    ]);
  });

  test("lastDelta: dgreif/ring#1816 のシナリオ（40000/90000, 40001/93000 → 100/5000, 101/8000）を再現する", () => {
    // Arrange: #1816 互換の lastDelta、未観測時は 3000
    const rewriter = new RtpTimelineRewriter({
      timestampStep: "lastDelta",
      defaultTimestampStep: 3000,
    });
    seqTs(rewriter, [
      [40000, 90000],
      [40001, 93000],
    ]);

    // Act: 新しい接続（SSRC 違い）の 100/5000, 101/8000 を流す
    const out = [
      rewriter.rewrite(createMediaRtpPacket(100, 5000, { ssrc: 9 }), {
        source: 2,
      }),
      rewriter.rewrite(createMediaRtpPacket(101, 8000, { ssrc: 9 }), {
        source: 2,
      }),
    ].map((p) => [p!.header.sequenceNumber, p!.header.timestamp]);

    // Assert: 直前の増分 3000 で 40002/96000, 40003/99000 に続く
    expect(out).toEqual([
      [40002, 96000],
      [40003, 99000],
    ]);
  });

  test("lastDelta: 増分を観測していなければ defaultTimestampStep、それもなければ 1 を使う", () => {
    // Arrange: 1 パケットだけ流した 2 つの rewriter
    const withDefault = new RtpTimelineRewriter({
      timestampStep: "lastDelta",
      defaultTimestampStep: 960,
    });
    const withoutDefault = new RtpTimelineRewriter({
      timestampStep: "lastDelta",
    });
    seqTs(withDefault, [[1, 1000]]);
    seqTs(withoutDefault, [[1, 1000]]);
    withDefault.switchSource();
    withoutDefault.switchSource();

    // Act: 新ソースの最初のパケットを流す
    const a = seqTs(withDefault, [[50, 0]]);
    const b = seqTs(withoutDefault, [[50, 0]]);

    // Assert: 960 と 1 だけ進む
    expect(a).toEqual([[2, 1960]]);
    expect(b).toEqual([[2, 1001]]);
  });

  test("wallClock: 旧ソースの最終パケットから新ソースの最初のパケットまでの経過時間を media time に反映する", () => {
    // Arrange: 90 kHz、時計を注入し、video / audio を同じ経過時間で切り替える
    const clock = createManualClock(1000);
    const video = new RtpTimelineRewriter({
      clockRate: 90000,
      timestampStep: "wallClock",
      now: clock.now,
    });
    const audio = new RtpTimelineRewriter({ clockRate: 48000, now: clock.now });
    seqTs(video, [[1, 0]]);
    seqTs(audio, [[1, 0]]);

    // Act: 2.5 秒後に新ソースのパケットを流す（audio は既定の auto）
    clock.advance(2500);
    const v = video.rewrite(createMediaRtpPacket(77, 5), { source: "new" })!;
    const a = audio.rewrite(createMediaRtpPacket(88, 5), { source: "new" })!;

    // Assert: 2.5 s × clockRate だけ timestamp が進む
    expect([v.header.sequenceNumber, v.header.timestamp]).toEqual([2, 225000]);
    expect([a.header.sequenceNumber, a.header.timestamp]).toEqual([2, 120000]);
  });

  test("wallClock: padding や順序が入れ替わった遅延パケットは時刻の基準を動かさず、audio / video を同じ経過時間で切り替えられる", () => {
    // Arrange: video / audio を同時に開始する（どちらも 90 kHz 換算で比較できるよう同じ clockRate）
    const clock = createManualClock(0);
    const video = new RtpTimelineRewriter({ clockRate: 90000, now: clock.now });
    const audio = new RtpTimelineRewriter({ clockRate: 90000, now: clock.now });
    video.rewrite(createMediaRtpPacket(1, 1000), { source: "old" });
    video.rewrite(createMediaRtpPacket(2, 2000), { source: "old" });
    audio.rewrite(createMediaRtpPacket(1, 1000), { source: "old" });
    audio.rewrite(createMediaRtpPacket(2, 2000), { source: "old" });

    // Act: 0.9 秒後に video だけ同じ timestamp の padding と古い timestamp の遅延パケットを受け、1 秒後に両方を切り替える
    clock.advance(900);
    video.rewrite(
      createPaddingOnlyRtpPacket({
        sequenceNumber: 3,
        timestamp: 2000,
        ssrc: 1111,
      }),
      { source: "old" },
    );
    video.rewrite(createMediaRtpPacket(1, 1000), { source: "old" });
    clock.advance(100);
    const v = video.rewrite(createMediaRtpPacket(50, 0), { source: "new" })!;
    const a = audio.rewrite(createMediaRtpPacket(50, 0), { source: "new" })!;

    // Assert: どちらも 2000 から 1 秒（90000）進み、同じ timestamp になる
    expect(v.header.timestamp).toBe(92000);
    expect(a.header.timestamp).toBe(92000);
  });

  test("switchSource の timestampStep はその切替だけ既定の方式より優先され、経過時間 0 でも 1 以上進む", () => {
    // Arrange: wallClock で時間を進めない
    const clock = createManualClock();
    const rewriter = new RtpTimelineRewriter({
      clockRate: 90000,
      now: clock.now,
    });
    seqTs(rewriter, [[1, 100]]);

    // Act: 明示 step で切り替え、続けて step 指定なしで切り替える
    rewriter.switchSource({ timestampStep: 4500 });
    const first = seqTs(rewriter, [[10, 0]]);
    rewriter.switchSource();
    const second = seqTs(rewriter, [[20, 0]]);

    // Assert: 1 回目は 4500、2 回目は経過時間 0 でも最小の 1 だけ進む
    expect(first).toEqual([[2, 4600]]);
    expect(second).toEqual([[3, 4601]]);
  });

  test("16bit seq / 32bit timestamp の wrap をまたいでも連続する", () => {
    // Arrange: 出力が 65535 / 0xffffff00 に達したソース
    const rewriter = new RtpTimelineRewriter({ timestampStep: 0x200 });
    seqTs(rewriter, [
      [65534, 0xfffffe00],
      [65535, 0xffffff00],
    ]);
    rewriter.switchSource();

    // Act: 新ソースで 3 パケット流す（その中でも入力 seq が wrap する）
    const out = seqTs(rewriter, [
      [65535, 10],
      [0, 0x10a],
      [1, 0x20a],
    ]);

    // Assert: 0, 1, 2 と ts 0x100, 0x200, 0x300 に続く
    expect(out).toEqual([
      [0, 0x100],
      [1, 0x200],
      [2, 0x300],
    ]);
  });

  test("切替後に届いた旧ソースのパケットは source キーでも SSRC でも破棄される", () => {
    // Arrange: source キーで 1 → 2、その後 SSRC の変化で切り替える
    const rewriter = new RtpTimelineRewriter({ timestampStep: 1 });
    const drops: string[] = [];
    rewriter.onDrop.subscribe((_, reason) => drops.push(reason));
    rewriter.rewrite(createMediaRtpPacket(100, 0, { ssrc: 1 }), { source: 1 });
    rewriter.rewrite(createMediaRtpPacket(5, 0, { ssrc: 2 }), { source: 2 });

    // Act: 旧キーの遅延パケット、新キー内の SSRC 変化、旧 SSRC の遅延パケットを流す
    const staleKey = rewriter.rewrite(
      createMediaRtpPacket(101, 0, { ssrc: 1 }),
      { source: 1 },
    );
    const nextSsrc = rewriter.rewrite(
      createMediaRtpPacket(900, 0, { ssrc: 3 }),
      { source: 2 },
    );
    const staleSsrc = rewriter.rewrite(
      createMediaRtpPacket(6, 0, { ssrc: 2 }),
      { source: 2 },
    );

    // Assert: 旧ソースは破棄、SSRC の変化は切替として 102 に続く
    expect(staleKey).toBeUndefined();
    expect(staleSsrc).toBeUndefined();
    expect(nextSsrc!.header.sequenceNumber).toBe(102);
    expect(drops).toEqual(["staleSource", "staleSource"]);
    expect(rewriter.sequenceNumber).toBe(102);
  });

  test("65 回を超える切替の後でも、ずっと古い世代のパケットは破棄され現在世代は止まらない", () => {
    // Arrange: 世代 0..70 を 1 パケットずつ流し、世代 70 を現在世代にする
    const rewriter = new RtpTimelineRewriter({ timestampStep: 1 });
    const drops: string[] = [];
    rewriter.onDrop.subscribe((_, reason) => drops.push(reason));
    for (let generation = 0; generation <= 70; generation++) {
      rewriter.rewrite(createMediaRtpPacket(100 + generation, 0, { ssrc: 1 }), {
        source: generation,
      });
    }
    const before = rewriter.sequenceNumber!;

    // Act: 履歴の古い世代 0 のパケットの後に、現在世代 70 のパケットを流す
    const stale = rewriter.rewrite(createMediaRtpPacket(500, 0, { ssrc: 1 }), {
      source: 0,
    });
    const current = rewriter.rewrite(
      createMediaRtpPacket(171, 0, { ssrc: 1 }),
      { source: 70 },
    );

    // Assert: 古い世代は破棄され、現在世代は破棄されず出力が続く
    expect(stale).toBeUndefined();
    expect(drops).toEqual(["staleSource"]);
    expect(current).toBeDefined();
    expect(current!.header.sequenceNumber).toBe((before + 1) & 0xffff);
  });

  test("switchSource({ source }) で SSRC が変わっても、旧 SSRC は新 source の廃止済み SSRC にならない", () => {
    // Arrange: source A / SSRC 111 を流し、明示的に source B へ切り替える
    const rewriter = new RtpTimelineRewriter({ timestampStep: 1 });
    rewriter.rewrite(createMediaRtpPacket(100, 0, { ssrc: 111 }), {
      source: "A",
    });
    rewriter.switchSource({ source: "B" });

    // Act: B の最初のパケットは SSRC 222、その後 B で SSRC 111 を使う
    const first = rewriter.rewrite(createMediaRtpPacket(5, 0, { ssrc: 222 }), {
      source: "B",
    });
    const reused = rewriter.rewrite(
      createMediaRtpPacket(900, 0, { ssrc: 111 }),
      {
        source: "B",
      },
    );
    const staleA = rewriter.rewrite(
      createMediaRtpPacket(101, 0, { ssrc: 111 }),
      {
        source: "A",
      },
    );

    // Assert: B の SSRC 111 は破棄されず切替として続き、A のパケットだけ破棄される
    expect(first!.header.sequenceNumber).toBe(101);
    expect(reused).toBeDefined();
    expect(reused!.header.sequenceNumber).toBe(102);
    expect(staleA).toBeUndefined();
  });

  test("switchSource({ source }) の直後から旧キーのパケットを破棄し、switchOnSsrcChange: false なら SSRC 変化では切り替えない", () => {
    // Arrange: SSRC 変化では切り替えない設定
    const rewriter = new RtpTimelineRewriter({
      switchOnSsrcChange: false,
      timestampStep: 1,
    });
    rewriter.rewrite(createMediaRtpPacket(10, 0, { ssrc: 1 }), { source: "a" });

    // Act: 同じキーで SSRC だけ変わったパケット、明示切替後の旧キーと新キーのパケットを流す
    const sameKey = rewriter.rewrite(createMediaRtpPacket(11, 0, { ssrc: 2 }), {
      source: "a",
    });
    rewriter.switchSource({ source: "b" });
    const stale = rewriter.rewrite(createMediaRtpPacket(12, 0), {
      source: "a",
    });
    const next = rewriter.rewrite(createMediaRtpPacket(500, 0), {
      source: "b",
    });

    // Assert: SSRC 変化はそのまま、旧キーは破棄、新キーは 12 に続く
    expect(sameKey!.header.sequenceNumber).toBe(11);
    expect(stale).toBeUndefined();
    expect(next!.header.sequenceNumber).toBe(12);
  });

  test("新ソースの最初のパケットより古いパケットは破棄され、出力 seq は後退も重複もしない", () => {
    // Arrange: 旧ソースの最後で順序が入れ替わり、最後に送ったのは古い 101
    const rewriter = new RtpTimelineRewriter({ timestampStep: 1 });
    const drops: string[] = [];
    rewriter.onDrop.subscribe((_, reason) => drops.push(reason));
    seqTs(rewriter, [
      [100, 0],
      [102, 20],
      [101, 10],
    ]);
    rewriter.switchSource();

    // Act: 新ソースで 50 の後に、それより古い 49, 48 と、新しい 51 を流す
    const out = seqTs(rewriter, [
      [50, 500],
      [49, 490],
      [48, 480],
      [51, 510],
    ]);

    // Assert: 旧ソースの最大 102 / ts 20 に続き、50 より古いパケットは破棄される
    expect(out).toEqual([[103, 21], undefined, undefined, [104, 31]]);
    expect(drops).toEqual(["beforeSourceStart", "beforeSourceStart"]);
  });

  test("新ソースの開始判定は入力 seq の wrap 後も誤って破棄しない", () => {
    // Arrange: 新ソースを 65000 から始める
    const rewriter = new RtpTimelineRewriter({ timestampStep: 1 });
    seqTs(rewriter, [[1, 0]]);
    rewriter.switchSource();
    seqTs(rewriter, [[65000, 0]]);

    // Act: 40000 パケット進めて（入力は wrap する）から、少し古いパケットを流す
    let last: number[] | undefined;
    for (let i = 1; i <= 40000; i++) {
      last = seqTs(rewriter, [[(65000 + i) & 0xffff, i]])[0];
    }
    const reordered = seqTs(rewriter, [[(65000 + 39990) & 0xffff, 39990]]);

    // Assert: すべて出力され、古いパケットは相対位置を保つ
    expect(last).toEqual([40002, 40001]);
    expect(reordered).toEqual([[39992, 39991]]);
  });

  test("padding-only パケットは media と同じ seq 空間で写像し、lastDelta の増分には数えない", () => {
    // Arrange: media の増分は 3000、padding は ts を進める
    const rewriter = new RtpTimelineRewriter({ timestampStep: "lastDelta" });
    seqTs(rewriter, [
      [1, 0],
      [2, 3000],
    ]);
    const padding = rewriter.rewrite(
      createPaddingOnlyRtpPacket({
        sequenceNumber: 3,
        timestamp: 3100,
        ssrc: 1111,
      }),
    )!;
    rewriter.switchSource();

    // Act: 新ソースのパケットを流す
    const out = seqTs(rewriter, [[70, 7]]);

    // Assert: padding は seq 3 のまま出力され、切替は media の増分 3000 で進む
    expect(padding.header.sequenceNumber).toBe(3);
    expect(out).toEqual([[4, 6100]]);
  });

  test("30 分ごとの再接続を模した複数回の切替でも出力 seq / timestamp は単調に連続する", () => {
    // Arrange: 30 fps video、接続ごとに seq / ts / SSRC の原点がばらばら
    const clock = createManualClock();
    const rewriter = new RtpTimelineRewriter({
      clockRate: 90000,
      now: clock.now,
    });
    const outputs: { seq: number; ts: number }[] = [];

    // Act: 5 世代 × 100 フレームを、切替のたびに 2 秒空けて流す
    for (let generation = 0; generation < 5; generation++) {
      const seqBase = (generation * 20011 + 65400) & 0xffff;
      const tsBase = (generation * 0x5fffffff + 0xfffff000) >>> 0;
      for (let frame = 0; frame < 100; frame++) {
        const out = rewriter.rewrite(
          createMediaRtpPacket(
            (seqBase + frame) & 0xffff,
            (tsBase + frame * 3000) >>> 0,
            { ssrc: 1000 + generation },
          ),
          { source: generation },
        )!;
        outputs.push({
          seq: out.header.sequenceNumber,
          ts: out.header.timestamp,
        });
        clock.advance(33);
      }
      clock.advance(2000);
    }

    // Assert: seq は常に +1、ts は前より進み、切替では経過時間分（≒ 2033 ms）進む
    for (let i = 1; i < outputs.length; i++) {
      expect(outputs[i].seq).toBe((outputs[i - 1].seq + 1) & 0xffff);
      const tsDelta = (outputs[i].ts - outputs[i - 1].ts) >>> 0;
      expect(tsDelta === 3000 || tsDelta === 182970).toBe(true);
    }
    expect(outputs[0]).toEqual({ seq: 65400, ts: 0xfffff000 });
  });

  test("SrtpSession の encrypt → decrypt を通しても、切替をまたいだパケットは ROC 誤推定や SrtpReplayError なしに受理される", () => {
    // Arrange: 下流 SRTP の SSRC を固定し、旧ソースは seq 65530 付近（ROC が繰り上がる直前）
    const { sender, receiver } = createSrtpSessionPair();
    const rewriter = new RtpTimelineRewriter({
      ssrc: 0x1234,
      timestampStep: "lastDelta",
    });
    const sendThrough = (
      seq: number,
      ts: number,
      source: number,
      payloadByte: number,
    ) => {
      const out = rewriter.rewrite(
        createMediaRtpPacket(seq, ts, {
          ssrc: 100 + source,
          payload: Buffer.from([payloadByte, payloadByte]),
        }),
        { source },
      );
      if (!out) return undefined;
      const decrypted = receiver.decrypt(
        sender.encrypt(out.payload, out.header),
      );
      return decrypted.subarray(decrypted.length - 2);
    };
    const received: (Buffer | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      received.push(sendThrough(65530 + i, i * 3000, 0, i));
    }

    // Act: 新しい接続（seq 10 から、旧接続の遅延パケットつき）へ切り替えて流す
    for (let i = 0; i < 10; i++) {
      received.push(sendThrough(10 + i, 777 + i * 3000, 1, 0x40 + i));
      if (i === 1) {
        received.push(sendThrough(65534, 4 * 3000, 0, 0xff));
      }
    }

    // Assert: 旧接続の遅延パケット以外は、すべて復号され payload が一致する
    const expected = [
      ...[0, 1, 2, 3].map((i) => Buffer.from([i, i])),
      ...[0, 1].map((i) => Buffer.from([0x40 + i, 0x40 + i])),
      undefined,
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => Buffer.from([0x40 + i, 0x40 + i])),
    ];
    expect(received).toEqual(expected);
    expect(rewriter.sequenceNumber).toBe((65530 + 13) & 0xffff);
    // Assert: 同じ出力を再送すると replay として拒否される（受信側の窓が有効なまま）
    const replay = rewriter.rewrite(
      createMediaRtpPacket(19, 777 + 9 * 3000, { ssrc: 101 }),
      { source: 1 },
    )!;
    expect(() =>
      receiver.decrypt(sender.encrypt(replay.payload, replay.header)),
    ).toThrow(SrtpReplayError);
  });

  test("最初のパケットより前の switchSource は何も書き換えず、mapTimestamp は現在の offset を返す", () => {
    // Arrange: 最初のパケットの前に切替を予約する
    const rewriter = new RtpTimelineRewriter({ timestampStep: 3000 });
    rewriter.switchSource({ source: 1 });

    // Act: source 1 のパケット、その後 source 2 のパケットを流す
    const first = rewriter.rewrite(createMediaRtpPacket(10, 1000), {
      source: 1,
    })!;
    rewriter.rewrite(createMediaRtpPacket(70, 50), { source: 2 });

    // Assert: 最初は入力のまま、切替後の mapTimestamp は新しい offset で写像する
    expect([first.header.sequenceNumber, first.header.timestamp]).toEqual([
      10, 1000,
    ]);
    expect(rewriter.mapTimestamp(50)).toBe(4000);
    expect(rewriter.mapTimestamp(150)).toBe(4100);
  });
});
