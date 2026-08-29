import { setTimeout } from "timers/promises";

import { vi } from "vitest";
import {
  GenericNack,
  MediaStreamTrack,
  RtcpTransportLayerFeedback,
  RtpPacket,
  unwrapRtx,
} from "../../src";
import { RTCRtpCodecParameters } from "../../src/media/parameters";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { RTCStatsReport } from "../../src/media/stats";
import {
  createConnectedRtpSender,
  createDtlsTransport,
  createRtpPacket,
  sentRtpHeaders,
} from "../fixture";

describe("media/rtpSender", () => {
  test("stop track", () => {
    const track = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);

    const spy = vi.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);

    track.stop();
    expect(spy).toBeCalledTimes(2);
  });

  test("replaceTrack", async () => {
    const track1 = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track1);
    sender.setDtlsTransport(dtls);
    const spy = vi.spyOn(sender, "sendRtp");

    const rtp = createRtpPacket();

    track1.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });
    await sender.replaceTrack(track2);

    track1.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track2.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
  });

  test("replaceTrack without first RTP still continues sequence and timestamp", async () => {
    const track1 = new MediaStreamTrack({ kind: "audio" });
    const dtls = createDtlsTransport();
    dtls.state = "connected";
    const sender = new RTCRtpSender(track1);
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });
    const sent: Array<{ sequenceNumber: number; timestamp: number }> = [];
    vi.spyOn(dtls, "sendRtp").mockImplementation(async (_payload, header) => {
      sent.push({
        sequenceNumber: header.sequenceNumber,
        timestamp: header.timestamp,
      });
      return 0;
    });

    const first = createRtpPacket();
    first.header.sequenceNumber = 5000;
    first.header.timestamp = 900000;
    await sender.sendRtp(first);

    const track2 = new MediaStreamTrack({ kind: "audio" });
    // 実行: 先頭 RTP がまだ無い track へ置換し、その後 seq/ts が小さいパケットを送る。
    await Promise.race([
      sender.replaceTrack(track2),
      setTimeout(200).then(() => {
        throw new Error("replaceTrack waited for the first RTP packet");
      }),
    ]);
    expect(track2.header).toBeUndefined();

    const second = createRtpPacket();
    second.header.sequenceNumber = 1;
    second.header.timestamp = 0;
    track2.onReceiveRtp.execute(second);
    await setTimeout(0);

    // 検証: 置換は待たず完了し、送出 RTP は直前の seq+1 / timestamp+1 で継続する。
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ sequenceNumber: 5000, timestamp: 900000 });
    expect(sent[1]).not.toEqual({ sequenceNumber: 1, timestamp: 0 });
    expect(sent[1].sequenceNumber).toBe(5001);
    expect(sent[1].timestamp).toBe(900001);
  });

  test("replaceTrack unsubscribes previous track onSourceChanged", async () => {
    const track1 = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track1);
    sender.setDtlsTransport(dtls);

    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });
    await sender.replaceTrack(track2);
    const spy = vi.spyOn(sender, "replaceRTP");

    // 実行: 置換前の track で sourceChanged を発火する。
    track1.onSourceChanged.execute({ sequenceNumber: 9, timestamp: 99 });

    // 検証: 旧 track の通知は sender に届かない。
    expect(spy).not.toHaveBeenCalled();

    // 実行: 置換後の track で sourceChanged を発火する。
    track2.onSourceChanged.execute({ sequenceNumber: 10, timestamp: 100 });

    // 検証: 新 track の通知だけが replaceRTP に届く。
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ sequenceNumber: 10, timestamp: 100 });
  });

  test("abort runRtcp", async () =>
    new Promise<void>(async (done) => {
      const dtls = createDtlsTransport();
      const sender = new RTCRtpSender("audio");
      sender.setDtlsTransport(dtls);

      Promise.any([
        setTimeout(200).then(() => false),
        sender.runRtcp().then(() => true),
      ]).then((res) => {
        expect(res).toBeTruthy();
        done();
      });

      await setTimeout(10);
      sender.stop();
    }));

  test("stop discards pending RTP and does not flush after DTLS connects", async () => {
    const track = new MediaStreamTrack({ kind: "audio" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });
    const sendRtpSpy = vi.spyOn(dtls, "sendRtp");

    // 実行: DTLS 未接続で RTP を積んだあと stop し、その後 connected にする。
    const queued = sender.sendRtp(createRtpPacket());
    expect(pendingRtpQueue(sender)).toHaveLength(1);
    sender.stop();
    await queued;
    dtls.state = "connected";
    dtls.onStateChange.execute("connected");
    await sender.sendRtp(createRtpPacket());
    await setTimeout(0);

    // 検証: 停止後は待機 RTP が破棄され、enqueue / flush されない。
    expect(pendingRtpQueue(sender)).toHaveLength(0);
    expect(sendRtpSpy).not.toHaveBeenCalled();
  });

  test("replaceTrack(null) discards pending RTP", async () => {
    const track = new MediaStreamTrack({ kind: "audio" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });

    // 実行: 未接続のまま RTP を積んで replaceTrack(null) する。
    const queued = sender.sendRtp(createRtpPacket());
    expect(pendingRtpQueue(sender)).toHaveLength(1);
    await sender.replaceTrack(null);
    await queued;

    // 検証: 待機 RTP は破棄される。
    expect(pendingRtpQueue(sender)).toHaveLength(0);
  });

  test("cloned tracks keep independent RTP headers across senders", async () => {
    const source = new MediaStreamTrack({ kind: "audio" });
    const clone = source.clone();
    const original = createConnectedRtpSender({ track: source });
    const cloned = createConnectedRtpSender({ track: clone });

    const packet = createRtpPacket(10, 90000);
    packet.header.ssrc = 7;
    packet.header.payloadType = 8;

    // 実行: 元 track へ書き込み、2 つの sender へ fan-out する。
    source.writeRtp(packet);
    await waitForSent(original.sendRtp, 1);
    await waitForSent(cloned.sendRtp, 1);

    // 検証: 入力パケットは汚染されず、各 sender は独自の SSRC / seq / ts を出す。
    expect(packet.header.ssrc).toBe(7);
    expect(packet.header.payloadType).toBe(8);
    expect(packet.header.sequenceNumber).toBe(10);
    expect(packet.header.timestamp).toBe(90000);

    const [headerA] = sentRtpHeaders(original.sendRtp);
    const [headerB] = sentRtpHeaders(cloned.sendRtp);
    expect(headerA.ssrc).toBe(original.sender.ssrc);
    expect(headerB.ssrc).toBe(cloned.sender.ssrc);
    expect(headerA.ssrc).not.toBe(headerB.ssrc);
    expect(headerA.ssrc).not.toBe(7);
    expect(headerB.ssrc).not.toBe(7);
    expect(headerA.sequenceNumber).toBe(10);
    expect(headerB.sequenceNumber).toBe(10);
    expect(headerA.timestamp).toBe(90000);
    expect(headerB.timestamp).toBe(90000);

    original.sendRtp.mockClear();
    cloned.sendRtp.mockClear();

    // 実行: 片側 sender だけ追加パケットを送る。
    await original.sender.sendRtp(createRtpPacket(11, 90040));

    // 検証: もう一方の sender のタイムラインは動かない。
    expect(original.sendRtp).toHaveBeenCalledTimes(1);
    expect(cloned.sendRtp).not.toHaveBeenCalled();
    expect(sentRtpHeaders(original.sendRtp)[0].ssrc).toBe(original.sender.ssrc);
    expect(sentRtpHeaders(original.sendRtp)[0].sequenceNumber).toBe(11);

    original.sender.stop();
    cloned.sender.stop();
  });

  test("RTP fan-out copies packets before the first subscriber mutates them", () => {
    const source = new MediaStreamTrack({ kind: "audio" });
    const clone = source.clone();
    const seen: number[] = [];
    source.onReceiveRtp.subscribe((rtp) => {
      rtp.header.ssrc = 42;
    });
    clone.onReceiveRtp.subscribe((rtp) => {
      seen.push(rtp.header.ssrc);
    });

    // 実行: 先頭購読者が SSRC を書き換える。
    const packet = createRtpPacket();
    packet.header.ssrc = 7;
    source.writeRtp(packet);

    // 検証: clone は元の SSRC を受け取り、入力パケットも汚染されない。
    expect(seen).toEqual([7]);
    expect(packet.header.ssrc).toBe(7);
  });

  test("pending RTP flush keeps later packets in arrival order", async () => {
    const track = new MediaStreamTrack({ kind: "audio" });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });

    const firstSend = deferred();
    const sent: number[] = [];
    let calls = 0;
    vi.spyOn(dtls, "sendRtp").mockImplementation(async (_payload, header) => {
      sent.push(header.sequenceNumber);
      calls += 1;
      if (calls === 1) {
        await firstSend.promise;
      }
      return 0;
    });

    // 実行: 未接続で [1,2] を積み、接続直後の flush 中に 3 を送る。
    void sender.sendRtp(createRtpPacket(1, 1000));
    void sender.sendRtp(createRtpPacket(2, 2000));
    dtls.state = "connected";
    dtls.onStateChange.execute("connected");
    const late = sender.sendRtp(createRtpPacket(3, 3000));
    const lateState = watchPromise(late);
    await waitUntil(() => sent.length === 1);

    // 検証: 1件目の DTLS 送信中は 3 件目の Promise が未解決のまま。
    expect(sent).toEqual([1]);
    expect(lateState.status).toBe("pending");

    firstSend.resolve();
    await late;
    await waitUntil(() => sent.length === 3);

    // 検証: 接続前後の入力 [1,2,3] が同順で送出される。
    expect(sent).toEqual([1, 2, 3]);
    expect(lateState.status).toBe("resolved");
    sender.stop();
  });

  test("later sendRtp waits for its own DTLS write while an earlier send is delayed", async () => {
    const { sender, dtls } = arrangeDisconnectedSender();
    dtls.state = "connected";

    const firstSend = deferred();
    const sent: number[] = [];
    vi.spyOn(dtls, "sendRtp").mockImplementation(async (_payload, header) => {
      sent.push(header.sequenceNumber);
      if (sent.length === 1) {
        await firstSend.promise;
      }
      return 0;
    });

    // 実行: 1件目の DTLS 送信を保留したまま 2件目を呼ぶ。
    const first = sender.sendRtp(createRtpPacket(1, 1000));
    const second = sender.sendRtp(createRtpPacket(2, 2000));
    const firstState = watchPromise(first);
    const secondState = watchPromise(second);
    await waitUntil(() => sent.length === 1);

    // 検証: 送信履歴が [1] の時点では 2件目は未解決。
    expect(sent).toEqual([1]);
    expect(firstState.status).toBe("pending");
    expect(secondState.status).toBe("pending");

    firstSend.resolve();
    await first;
    await second;

    // 検証: 1件目完了後に 2件目も送信され、両方 resolve する。
    expect(sent).toEqual([1, 2]);
    expect(firstState.status).toBe("resolved");
    expect(secondState.status).toBe("resolved");
    sender.stop();
  });

  test("DTLS failure rejects only the sendRtp that wrote that packet", async () => {
    const { sender, dtls } = arrangeDisconnectedSender();
    dtls.state = "connected";

    let calls = 0;
    vi.spyOn(dtls, "sendRtp").mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error("dtls send failed");
      }
      return 0;
    });

    // 実行: 2件目だけ DTLS 送信を失敗させる。
    const first = sender.sendRtp(createRtpPacket(1, 1000));
    const second = sender.sendRtp(createRtpPacket(2, 2000));

    // 検証: 1件目は resolve、2件目は reject される。
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("dtls send failed");
    sender.stop();
  });

  test("stop resolves queued sendRtp promises without leaving them pending", async () => {
    const { sender } = arrangeDisconnectedSender();

    // 実行: 未接続のまま積んだ RTP を stop で破棄する。
    const queued = sender.sendRtp(createRtpPacket(1, 1000));
    const queuedState = watchPromise(queued);
    expect(pendingRtpQueue(sender)).toHaveLength(1);
    expect(queuedState.status).toBe("pending");
    sender.stop();
    await queued;

    // 検証: 破棄後は Promise が resolve し、キューが空。
    expect(queuedState.status).toBe("resolved");
    expect(pendingRtpQueue(sender)).toHaveLength(0);
  });

  test("pending queue overflow resolves the dropped sendRtp promise", async () => {
    const { sender } = arrangeDisconnectedSender();
    const pendingLimit = 256;

    // 実行: 上限を超える RTP を未接続キューへ積む。
    const first = sender.sendRtp(createRtpPacket(0, 0));
    const firstState = watchPromise(first);
    for (let index = 1; index < pendingLimit; index++) {
      void sender.sendRtp(createRtpPacket(index, index));
    }
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    expect(firstState.status).toBe("pending");
    const overflow = sender.sendRtp(
      createRtpPacket(pendingLimit, pendingLimit),
    );
    const overflowState = watchPromise(overflow);

    // 検証: 最古の Promise は破棄で resolve し、新しいパケットは待機したまま。
    await first;
    expect(firstState.status).toBe("resolved");
    expect(overflowState.status).toBe("pending");
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    sender.stop();
    await overflow;
    expect(overflowState.status).toBe("resolved");
  });

  test("getStats returns a report rooted at outbound stats", async () => {
    const track = new MediaStreamTrack({ kind: "audio", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);

    // Act: sender 単位の stats を取得する。
    const report = await sender.getStats();

    // Assert: W3C 互換の RTCStatsReport と参照 closure が返る。
    expect(report).toBeInstanceOf(RTCStatsReport);

    const outbound = Array.from(report.values()).find(
      (stat) => stat.type === "outbound-rtp",
    ) as any;
    expect(outbound).toBeDefined();
    expect(outbound.mediaSourceId).toBeDefined();
    expect(report.has(outbound.mediaSourceId)).toBe(true);

    if (outbound.transportId) {
      expect(report.has(outbound.transportId)).toBe(true);
    }

    expect(
      Array.from(report.values()).some(
        (stat) => stat.type === "peer-connection",
      ),
    ).toBe(false);
  });
});

function pendingRtpQueue(sender: RTCRtpSender) {
  return (sender as unknown as { pendingRtp: unknown[] }).pendingRtp;
}

function arrangeDisconnectedSender() {
  const track = new MediaStreamTrack({ kind: "audio" });
  const dtls = createDtlsTransport();
  const sender = new RTCRtpSender(track);
  sender.setDtlsTransport(dtls);
  sender.prepareSend({
    codecs: [
      new RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48000,
        payloadType: 111,
      }),
    ],
    headerExtensions: [],
  });
  return { track, dtls, sender };
}

function watchPromise(promise: Promise<unknown>) {
  const state: {
    status: "pending" | "resolved" | "rejected";
    error?: unknown;
  } = { status: "pending" };
  void promise.then(
    () => {
      state.status = "resolved";
    },
    (error) => {
      state.status = "rejected";
      state.error = error;
    },
  );
  return state;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForSent(
  sendRtp: ReturnType<typeof createConnectedRtpSender>["sendRtp"],
  count: number,
) {
  await waitUntil(() => sendRtp.mock.calls.length >= count);
}

describe("media/rtpSender RTP continuity", () => {
  const started: RTCRtpSender[] = [];

  afterEach(() => {
    for (const sender of started) {
      sender.stop();
    }
    started.length = 0;
  });

  const arrangeSender = (
    options?: Parameters<typeof createConnectedRtpSender>[0],
  ) => {
    const setup = createConnectedRtpSender(options);
    started.push(setup.sender);
    return setup;
  };
  test("replaceTrack は pending のみで probe を送出せず、先頭実送出でオフセットを確定する", async () => {
    const { sender, track, sendRtp } = arrangeSender();

    // Arrange: 旧ソースを送出して出力タイムラインを作る。
    await sender.sendRtp(createRtpPacket(40001, 93000));
    const last = sentRtpHeaders(sendRtp).at(-1)!;
    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });
    sendRtp.mockClear();

    // Act: 新 track のパケットを待たずに差し替える。
    await sender.replaceTrack(track2);

    // Assert: probe は出ず、差し替えは即時完了する。
    expect(sendRtp).not.toHaveBeenCalled();
    expect(sender.track).toBe(track2);

    // Act: 新ソースの先頭パケットを実送出する。
    track2.onReceiveRtp.execute(createRtpPacket(100, 5000));

    // Assert: 出力 seq は直前からちょうど 1、timestamp 増分は既定 1。
    const [header] = sentRtpHeaders(sendRtp);
    expect(header.sequenceNumber).toBe((last.sequenceNumber + 1) & 0xffff);
    expect(header.timestamp).toBe((last.timestamp + 1) >>> 0);
  });

  test("onSourceChanged は pending にし、直後の実送出でオフセットを確定する", async () => {
    const { sender, track, sendRtp } = arrangeSender();

    // Arrange: 送出済みタイムラインを用意する。
    await sender.sendRtp(createRtpPacket(10, 1000));
    const last = sentRtpHeaders(sendRtp).at(-1)!;
    sendRtp.mockClear();

    // Act: ソース切替を通知するだけで、まだ送出しない。
    track.onSourceChanged.execute({ sequenceNumber: 0, timestamp: 0 });

    // Assert: 切替通知だけではパケットを送らない。
    expect(sendRtp).not.toHaveBeenCalled();

    // Act: 新ソースの先頭パケットを実送出する。
    track.onReceiveRtp.execute(createRtpPacket(0, 0));

    // Assert: オフセットは実送出の入力 header で凍結される。
    const [header] = sentRtpHeaders(sendRtp);
    expect(header.sequenceNumber).toBe((last.sequenceNumber + 1) & 0xffff);
    expect(header.timestamp).toBe((last.timestamp + 1) >>> 0);
  });

  test("discontinuity=true でも先頭の出力 seq は直前からちょうど 1", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange
    await sender.sendRtp(createRtpPacket(7, 7000));
    const last = sentRtpHeaders(sendRtp).at(-1)!;
    sendRtp.mockClear();

    // Act: discontinuity 付きで切替予約し、先頭パケットを送る。
    sender.replaceRTP({ sequenceNumber: 1, timestamp: 1 }, true);
    await sender.sendRtp(createRtpPacket(200, 8000));

    // Assert: seq 追加ギャップは入らず、timestamp 増分も既定 1 のまま。
    const [header] = sentRtpHeaders(sendRtp);
    expect(header.sequenceNumber).toBe((last.sequenceNumber + 1) & 0xffff);
    expect(header.timestamp).toBe((last.timestamp + 1) >>> 0);
  });

  test("timestampStep は既定 1 で、明示指定時のみ境界 timestamp 増分が変わる", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange
    await sender.sendRtp(createRtpPacket(1, 1000));
    const last = sentRtpHeaders(sendRtp).at(-1)!;

    // Act: 第 3 引数未指定で切り替える。
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 });
    await sender.sendRtp(createRtpPacket(50, 9000));

    // Assert: 境界 timestamp は +1。
    expect(sentRtpHeaders(sendRtp).at(-1)!.timestamp).toBe(
      (last.timestamp + 1) >>> 0,
    );

    // Act: timestampStep を明示して再切替する。
    const afterDefault = sentRtpHeaders(sendRtp).at(-1)!;
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 }, false, 3000);
    await sender.sendRtp(createRtpPacket(0, 0));

    // Assert: 明示 step だけが境界 timestamp 増分を変える。
    expect(sentRtpHeaders(sendRtp).at(-1)!.timestamp).toBe(
      (afterDefault.timestamp + 3000) >>> 0,
    );
    expect(sentRtpHeaders(sendRtp).at(-1)!.sequenceNumber).toBe(
      (afterDefault.sequenceNumber + 1) & 0xffff,
    );
  });

  test("境界 timestamp は 32bit 演算のみで、uint16 では壊れる値でも連続する", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange: 16bit を超える timestamp を出力済みにする。
    await sender.sendRtp(createRtpPacket(1, 0xffff));
    sendRtp.mockClear();

    // Act: 新ソース先頭 ts=0 で切り替える。
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 });
    await sender.sendRtp(createRtpPacket(0, 0));

    // Assert: uint16Add なら 0 に落ちるが、uint32Add なら 0x10000。
    expect(sentRtpHeaders(sendRtp)[0].timestamp).toBe(0x10000);
  });

  test("seq の 16bit wrap と timestamp の 32bit wrap を跨いでも単調に進む", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange: 出力 seq を 65535、timestamp を 0xfffffffe にする。
    await sender.sendRtp(createRtpPacket(65535, 0xfffffffe));
    sendRtp.mockClear();

    // Act: wrap 境界でソースを切り替える。
    sender.replaceRTP({ sequenceNumber: 9, timestamp: 1 });
    await sender.sendRtp(createRtpPacket(9, 1));

    // Assert: seq は 0、timestamp は 0xffffffff。
    const [header] = sentRtpHeaders(sendRtp);
    expect(header.sequenceNumber).toBe(0);
    expect(header.timestamp).toBe(0xffffffff);

    // Act: timestamp も 32bit wrap する step で再切替する。
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 }, false, 2);
    await sender.sendRtp(createRtpPacket(0, 0));

    // Assert: 0xffffffff + 2 は 1 に戻る。
    expect(sentRtpHeaders(sendRtp).at(-1)!.sequenceNumber).toBe(1);
    expect(sentRtpHeaders(sendRtp).at(-1)!.timestamp).toBe(1);
  });

  test("切替後の欠落・再順序・重複は固定オフセットのまま相対関係が保存される", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange
    await sender.sendRtp(createRtpPacket(5, 5000));
    sender.replaceRTP({ sequenceNumber: 100, timestamp: 1000 });
    sendRtp.mockClear();

    // Act: 新ソースで欠落・再順序・重複を送る。
    await sender.sendRtp(createRtpPacket(100, 1000));
    await sender.sendRtp(createRtpPacket(102, 1080));
    await sender.sendRtp(createRtpPacket(101, 1040));
    await sender.sendRtp(createRtpPacket(102, 1080));

    // Assert: 入力の相対 seq/ts が出力にもそのまま残る。
    const headers = sentRtpHeaders(sendRtp);
    const baseSeq = headers[0].sequenceNumber;
    const baseTs = headers[0].timestamp;
    expect(headers.map((header) => header.sequenceNumber)).toEqual([
      baseSeq,
      (baseSeq + 2) & 0xffff,
      (baseSeq + 1) & 0xffff,
      (baseSeq + 2) & 0xffff,
    ]);
    expect(headers.map((header) => header.timestamp)).toEqual([
      baseTs,
      (baseTs + 80) >>> 0,
      (baseTs + 40) >>> 0,
      (baseTs + 80) >>> 0,
    ]);
  });

  test("同一 timestamp の複数 RTP は切替後も同一出力 timestamp になる", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange
    await sender.sendRtp(createRtpPacket(1, 90000));
    sender.replaceRTP({ sequenceNumber: 10, timestamp: 1 });
    sendRtp.mockClear();

    // Act: 同一フレームの 2 パケットを送る。
    await sender.sendRtp(createRtpPacket(10, 9999));
    await sender.sendRtp(createRtpPacket(11, 9999));

    // Assert: seq だけ進み、timestamp は共有される。
    const [first, second] = sentRtpHeaders(sendRtp);
    expect(second.sequenceNumber).toBe((first.sequenceNumber + 1) & 0xffff);
    expect(second.timestamp).toBe(first.timestamp);
  });

  test("連続した複数回のソース切替でもオフセットが安定する", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange / Act: ソース A → B → C と連続切替する。
    await sender.sendRtp(createRtpPacket(0, 1000));
    await sender.sendRtp(createRtpPacket(1, 1040));

    sender.replaceRTP({ sequenceNumber: 50, timestamp: 5000 });
    await sender.sendRtp(createRtpPacket(50, 5000));
    await sender.sendRtp(createRtpPacket(51, 5040));

    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 });
    await sender.sendRtp(createRtpPacket(0, 0));
    await sender.sendRtp(createRtpPacket(1, 40));

    // Assert: 切替のたびに seq は +1、各ソース内部の間隔は保存される。
    const headers = sentRtpHeaders(sendRtp);
    expect(headers.map((header) => header.sequenceNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(headers.map((header) => header.timestamp)).toEqual([
      1000, 1040, 1041, 1081, 1082, 1122,
    ]);
  });

  test("onSourceChanged 購読は replaceTrack と stop で解除される", async () => {
    const { sender, track: track1, sendRtp } = arrangeSender();

    // Arrange: track1 でタイムラインを作り、track2 へ差し替える。
    await sender.sendRtp(createRtpPacket(1, 1000));
    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });
    await sender.replaceTrack(track2);
    await sender.sendRtp(createRtpPacket(100, 2000));
    sendRtp.mockClear();

    // Act: 旧 track の onSourceChanged を発火したあと、新ソースの欠落パケットを送る。
    track1.onSourceChanged.execute({ sequenceNumber: 1, timestamp: 1 });
    await sender.sendRtp(createRtpPacket(105, 2200));

    // Assert: 旧購読が残っていると再凍結でギャップが潰れる。固定オフセットなら seq は +5。
    expect(sentRtpHeaders(sendRtp)[0].sequenceNumber).toBe(7);

    // Act: stop 後に残った track へ切替通知と RTP を流す。
    sender.stop();
    sendRtp.mockClear();
    track2.onSourceChanged.execute({ sequenceNumber: 0, timestamp: 0 });
    track2.onReceiveRtp.execute(createRtpPacket(0, 0));

    // Assert: stop で購読が外れ、送出されない。
    expect(sendRtp).not.toHaveBeenCalled();
  });

  test("rtpCache クリア後は切替前 seq を RTX せず、切替後 seq の NACK は RTX する", async () => {
    const { sender, sendRtp } = arrangeSender({ rtx: true });

    // Arrange: 切替前パケットをキャッシュしたあとソースを切り替える。
    await sender.sendRtp(createRtpPacket(1, 1000, Buffer.from([9])));
    const beforeSeq = sentRtpHeaders(sendRtp)[0].sequenceNumber;
    sender.replaceRTP({ sequenceNumber: 40, timestamp: 40 });
    await sender.sendRtp(createRtpPacket(40, 40, Buffer.from([8])));
    const afterSeq = sentRtpHeaders(sendRtp).at(-1)!.sequenceNumber;
    sendRtp.mockClear();

    // Act: 切替前 seq を NACK する。
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          lost: [beforeSeq],
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
        }),
      }),
    );
    await setTimeout(0);

    // Assert: rtpCache クリア後なので再送しない。
    expect(sendRtp).not.toHaveBeenCalled();

    // Act: 切替後 seq を NACK する。
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          lost: [afterSeq],
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
        }),
      }),
    );
    await setTimeout(0);

    // Assert: 書き換え後 seq の RTX が出る。
    expect(sendRtp).toHaveBeenCalledTimes(1);
    const rtxHeader = sentRtpHeaders(sendRtp)[0];
    expect(rtxHeader.payloadType).toBe(97);
    expect(rtxHeader.ssrc).toBe(sender.rtxSsrc);
    const recovered = unwrapRtx(
      new RtpPacket(rtxHeader, sendRtp.mock.calls[0][0]),
      96,
      sender.ssrc,
    );
    expect(recovered.header.sequenceNumber).toBe(afterSeq);
  });

  test("RTCP SR の rtpTimestamp は書き換え後値で、TWCC はメディア seq と独立に進む", async () => {
    const { sender, dtls, sendRtp } = arrangeSender({
      twcc: true,
      cname: "test",
    });

    // Arrange / Act: TWCC 付きで送出し、ソース切替後にもう 1 パケット送る。
    await sender.sendRtp(createRtpPacket(10, 500));
    const first = sentRtpHeaders(sendRtp)[0];
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 });
    await sender.sendRtp(createRtpPacket(0, 0));
    const second = sentRtpHeaders(sendRtp).at(-1)!;

    // Assert: SR が参照する rtpTimestamp は書き換え後 timestamp。
    expect((sender as any).rtpTimestamp).toBe(second.timestamp);
    expect(second.timestamp).not.toBe(0);
    expect(second.sequenceNumber).toBe((first.sequenceNumber + 1) & 0xffff);

    // Assert: TWCC はメディア seq と独立に 1, 2 と増える。
    const twccSeqs = sentRtpHeaders(sendRtp).map((header) =>
      header.extensions.find((ext) => ext.id === 3)!.payload.readUInt16BE(0),
    );
    expect(twccSeqs).toEqual([1, 2]);
    expect(dtls.transportSequenceNumber).toBe(2);
  });

  test("replaceRTP の header 引数はオフセット計算に使わず、次の実送出で確定する", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Arrange
    await sender.sendRtp(createRtpPacket(3, 3000));
    const last = sentRtpHeaders(sendRtp).at(-1)!;
    sendRtp.mockClear();

    // Act: 実送出とは異なる header で予約する。
    sender.replaceRTP({ sequenceNumber: 999, timestamp: 999999 });
    expect(sendRtp).not.toHaveBeenCalled();
    await sender.sendRtp(createRtpPacket(20, 400));

    // Assert: 凍結基準は replaceRTP に渡した header ではなく実送出パケット。
    const [header] = sentRtpHeaders(sendRtp);
    expect(header.sequenceNumber).toBe((last.sequenceNumber + 1) & 0xffff);
    expect(header.timestamp).toBe((last.timestamp + 1) >>> 0);
  });
});
