import { setTimeout } from "timers/promises";

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GccBandwidthEstimator,
  GenericNack,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpHeaderExtensionParameters,
  RTP_EXTENSION_URI,
  RtcpTransportLayerFeedback,
  RtpBuilder,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  dePacketizeRtpPackets,
  kProbePaddingPacketBytes,
  serializeTransportWideCC,
  unwrapRtx,
} from "../../src";
import { RTCRtpCodecParameters } from "../../src/media/parameters";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { RTCStatsReport } from "../../src/media/stats";
import { milliTime } from "../../src/utils";
import {
  attachPacedFifoEstimator,
  createAudioCodec,
  createConnectedRtpSender,
  createDtlsTransport,
  createRtpPacket,
  holdFirstDtlsWrite,
  sentRtpHeaders,
} from "../fixture";
import { createVideoReceiver } from "./rtpReceiverTestUtils";

describe("media/rtpSender", () => {
  test("stop releases the subscription on the DTLS transport", () => {
    // Arrange: DTLS transport に結び付けた sender。
    const dtls = createDtlsTransport();
    const before = dtls.onStateChange.length;
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    expect(dtls.onStateChange.length).toBe(before + 1);

    // Act: sender を止める (transceiver.stop())。
    sender.stop();

    // Assert: BUNDLE で共有して長く生きる transport が、止めた sender を参照し続けない。
    expect(dtls.onStateChange.length).toBe(before);
  });

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

  test("replaceTrack rejects a fixed source incompatible with the sending codec", async () => {
    const original = new MediaStreamTrack({
      kind: "video",
      codec: new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90_000,
        payloadType: 96,
      }),
    });
    const sender = new RTCRtpSender(original);
    sender.prepareSend({
      codecs: [
        original.codec!,
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90_000,
          payloadType: 97,
        }),
      ],
      headerExtensions: [],
    });
    const replacement = new MediaStreamTrack({
      kind: "video",
      codec: new RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90_000,
        payloadType: 97,
      }),
    });

    // 実行: H264も交渉済みだが、現在VP8送信中のsenderへfixed H264 sourceを指定する。
    const act = sender.replaceTrack(replacement);

    // 検証: RTP形式を切り替えずに誤送信しないよう、track変更前に拒否する。
    await expect(act).rejects.toMatchObject({
      name: "InvalidModificationError",
    });
    expect(sender.track).toBe(original);
    expect(sender.codec?.mimeType.toLowerCase()).toBe("video/vp8");
  });

  test("replaceTrack rejects a fixed source absent from negotiated primaries", async () => {
    const original = new MediaStreamTrack({ kind: "video" });
    const vp8 = new RTCRtpCodecParameters({
      mimeType: "video/VP8",
      clockRate: 90_000,
      payloadType: 96,
    });
    const sender = new RTCRtpSender(original);
    sender.prepareSend({ codecs: [vp8], headerExtensions: [] });
    const replacement = new MediaStreamTrack({
      kind: "video",
      codec: new RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90_000,
        payloadType: 97,
      }),
    });

    // 実行: H264を含まない交渉集合へfixed H264 sourceを置換する。
    const act = sender.replaceTrack(replacement);

    // 検証: sourceと互換なprimaryがないためtrack変更前に拒否する。
    await expect(act).rejects.toMatchObject({
      name: "InvalidModificationError",
    });
    expect(sender.track).toBe(original);
  });

  test("replaceTrack accepts a primary source wrapped by negotiated RED", async () => {
    const opus = new RTCRtpCodecParameters({
      mimeType: "audio/opus",
      clockRate: 48_000,
      channels: 2,
      payloadType: 96,
    });
    const original = new MediaStreamTrack({ kind: "audio", codec: opus });
    const sender = new RTCRtpSender(original);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/red",
          clockRate: 48_000,
          channels: 2,
          payloadType: 97,
          parameters: "96/96",
        }),
        opus,
      ],
      headerExtensions: [],
    });
    const replacement = new MediaStreamTrack({
      kind: "audio",
      codec: new RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48_000,
        channels: 2,
        payloadType: 96,
      }),
    });

    // 実行: RED が先頭の交渉後に、参照先と同じ fixed OPUS source へ置換する。
    await sender.replaceTrack(replacement);

    // 検証: auxiliary codec ではなく primary codec との互換性で許可する。
    expect(sender.track).toBe(replacement);
    expect(sender.codec?.mimeType.toLowerCase()).toBe("audio/red");
  });

  test("prepareSend clears excluded RTX and RED state", async () => {
    const sender = new RTCRtpSender(new MediaStreamTrack({ kind: "video" }));
    const vp8 = new RTCRtpCodecParameters({
      mimeType: "video/VP8",
      clockRate: 90000,
      payloadType: 96,
    });

    // 実行: 初回交渉で VP8 に紐づく RTX と RED を設定する。
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/red",
          clockRate: 90000,
          payloadType: 98,
          parameters: "96/96",
        }),
        vp8,
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: "apt=96",
        }),
      ],
      headerExtensions: [],
    });

    // 検証: 初回交渉の補助 codec 状態が保持される。
    expect(senderStatsState(sender)).toMatchObject({
      rtxPayloadType: 97,
      redRedundantPayloadType: 96,
    });

    // 実行: RTX/RED を含まない H264-only の再交渉結果を適用する。
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90000,
          payloadType: 100,
        }),
      ],
      headerExtensions: [],
    });
    const stats = await sender.getStats();
    const outbound = Array.from(stats.values()).find(
      (stat) => stat.type === "outbound-rtp",
    ) as { rtxSsrc?: number };

    // 検証: 除外済みの RTX/RED payload type と RTX 統計を残さない。
    expect(senderStatsState(sender)).toMatchObject({
      rtxPayloadType: undefined,
      redRedundantPayloadType: undefined,
    });
    expect(outbound.rtxSsrc).toBeUndefined();
  });

  test("prepareSend resolves RTX from its primary when RED is first", () => {
    const sender = new RTCRtpSender(new MediaStreamTrack({ kind: "video" }));

    // 実行: RED、VP8、RTX の順序で交渉結果を適用する。
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/red",
          clockRate: 90_000,
          payloadType: 98,
          parameters: "96/96",
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90_000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90_000,
          payloadType: 97,
          parameters: "apt=96",
        }),
      ],
      headerExtensions: [],
    });

    // 検証: RED を送信 codec に保ちつつ、RTX は参照先 VP8 から解決する。
    expect(sender.codec?.mimeType.toLowerCase()).toBe("video/red");
    expect(senderStatsState(sender).rtxPayloadType).toBe(97);
    expect(senderStatsState(sender).redRedundantPayloadType).toBe(96);
  });

  test("prepareSend selects RTX for the active primary only", () => {
    const sender = new RTCRtpSender(new MediaStreamTrack({ kind: "video" }));

    // 実行: VP8/H264 と各 codec 用 RTX を同時に交渉する。
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90_000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90_000,
          payloadType: 97,
          parameters: "apt=96",
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/H264",
          clockRate: 90_000,
          payloadType: 98,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90_000,
          payloadType: 99,
          parameters: "apt=98",
        }),
      ],
      headerExtensions: [],
    });

    // 検証: 実際の送信 codec VP8 に対応する RTX だけを選ぶ。
    expect(sender.codec?.mimeType.toLowerCase()).toBe("video/vp8");
    expect(senderStatsState(sender).rtxPayloadType).toBe(97);
  });

  test("prepareSend does not enable RED wrapping when primary is first", () => {
    const sender = new RTCRtpSender(new MediaStreamTrack({ kind: "audio" }));

    // 実行: OPUS preference相当の順序で、後続にREDがあるcodec一覧を適用する。
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48_000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "audio/red",
          clockRate: 48_000,
          payloadType: 97,
          parameters: "96/96",
        }),
      ],
      headerExtensions: [],
    });

    // 検証: RTP headerがOPUSのときRED wrappingを有効にしない。
    expect(sender.codec?.mimeType.toLowerCase()).toBe("audio/opus");
    expect(senderStatsState(sender).redRedundantPayloadType).toBeUndefined();
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
    const sender = new RTCRtpSender(track, { pendingRtp: true });
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
    const sender = new RTCRtpSender(track, { pendingRtp: true });
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

  test("同じ track を共有する sender は送信待ち中も自分の SSRC で送る", async () => {
    // Arrange: 1 つの track を 2 つの sender で共有し、A の DTLS 送信を保留可能にする。
    const track = new MediaStreamTrack({ kind: "audio" });
    const a = createConnectedRtpSender({ track });
    const b = createConnectedRtpSender({ track });
    const release = deferred();
    a.sendRtp.mockImplementation(async () => {
      if (a.sendRtp.mock.calls.length === 1) {
        await release.promise;
      }
      return 12;
    });

    // Act: A の 1 件目を保留させ、2 件目は A の送信キューで待たせる。
    track.writeRtp(createRtpPacket(1, 1000));
    await waitForSent(a.sendRtp, 1);
    track.writeRtp(createRtpPacket(2, 1040));
    await waitForSent(b.sendRtp, 2);

    // Act: B が共有パケットのヘッダーを書き換えた後で A を再開する。
    release.resolve();
    await waitForSent(a.sendRtp, 2);

    // Assert: 各 sender の全送信が自分自身の SSRC を持つ。
    expect(a.sender.ssrc).not.toBe(b.sender.ssrc);
    expect(sentRtpHeaders(a.sendRtp).map((h) => h.ssrc)).toEqual([
      a.sender.ssrc,
      a.sender.ssrc,
    ]);
    expect(sentRtpHeaders(b.sendRtp).map((h) => h.ssrc)).toEqual([
      b.sender.ssrc,
      b.sender.ssrc,
    ]);
    a.sender.stop();
    b.sender.stop();
  });

  test("sendRtp keeps media-clock timestamps including skip gaps as-is", async () => {
    // 準備: RtpBuilder でストール後の skip ギャップを含む timestamp 列を作る。
    const { sender, sendRtp } = createConnectedRtpSender();
    const builder = new RtpBuilder({
      initialSequenceNumber: 100,
      initialTimestamp: 0xffffff00,
    });
    const packets = [
      builder.create(Buffer.from([1])),
      builder.create(Buffer.from([2]), { elapsedSamples: 960 }),
      builder.create(Buffer.from([3]), { elapsedSamples: 960 * 250 }),
    ];

    // 実行: 送信時刻とは無関係な間隔で sendRtp する。
    for (const packet of packets) {
      await sender.sendRtp(packet);
      await setTimeout(5);
    }

    // 検証: 送出 timestamp は入力のまま (wrap とギャップを含め書き換えない)。
    expect(sentRtpHeaders(sendRtp).map((h) => h.timestamp)).toEqual(
      packets.map((p) => p.header.timestamp),
    );
    expect(sentRtpHeaders(sendRtp).map((h) => h.timestamp)).toEqual([
      0xffffff00,
      (0xffffff00 + 960) % 2 ** 32,
      (0xffffff00 + 960 * 251) % 2 ** 32,
    ]);
    sender.stop();
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
    const sender = new RTCRtpSender(track, { pendingRtp: true });
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
    const pendingLimit = 3;
    const { sender } = arrangeDisconnectedSender({
      pendingRtp: { maxLength: pendingLimit },
    });

    // 実行: 指定した maxLength を超える RTP を未接続キューへ積む。
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

  test("pending RTP is disabled by default and drops packets before DTLS connects", async () => {
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

    // 実行: オプション未指定のまま未接続で sendRtp し、その後 connected にする。
    await sender.sendRtp(createRtpPacket());
    expect(pendingRtpQueue(sender)).toHaveLength(0);
    dtls.state = "connected";
    dtls.onStateChange.execute("connected");
    await setTimeout(0);

    // 検証: 既定ではキューに積まれず、接続後もフラッシュされない。
    expect(pendingRtpQueue(sender)).toHaveLength(0);
    expect(sendRtpSpy).not.toHaveBeenCalled();
    sender.stop();
  });

  test("RTCPeerConnection pendingRtp option is applied to senders", async () => {
    const pendingLimit = 2;
    const pc = new RTCPeerConnection({
      pendingRtp: { maxLength: pendingLimit },
    });
    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);

    // 実行: PC から作った sender に未接続 RTP を上限まで積み、さらに 1 件溢す。
    const first = sender.sendRtp(createRtpPacket(0, 0));
    void sender.sendRtp(createRtpPacket(1, 1));
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    const overflow = sender.sendRtp(createRtpPacket(2, 2));
    const overflowState = watchPromise(overflow);

    // 検証: PeerConfig の maxLength が sender に渡り、溢れた最古は resolve する。
    await first;
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    expect(overflowState.status).toBe("pending");
    pc.close();
  });

  test("getConfiguration pendingRtp snapshot does not change sender queue limit", async () => {
    // Arrange: オブジェクト指定の pendingRtp で PC を作る
    const pendingLimit = 2;
    const pc = new RTCPeerConnection({
      pendingRtp: { maxLength: pendingLimit },
    });
    const snapshot = pc.getConfiguration();

    // Act: 公開スナップショットの maxLength だけ書き換える
    expect(typeof snapshot.pendingRtp).toBe("object");
    if (typeof snapshot.pendingRtp === "object" && snapshot.pendingRtp) {
      snapshot.pendingRtp.maxLength = 99;
    }

    // Assert: 内部設定は元の上限のまま。後から作る sender も 2 件で溢れる
    const reread = pc.getConfiguration().pendingRtp;
    expect(typeof reread).toBe("object");
    expect(
      typeof reread === "object" && reread ? reread.maxLength : undefined,
    ).toBe(pendingLimit);
    const track = new MediaStreamTrack({ kind: "audio" });
    const sender = pc.addTrack(track);
    const first = sender.sendRtp(createRtpPacket(0, 0));
    void sender.sendRtp(createRtpPacket(1, 1));
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    const overflow = sender.sendRtp(createRtpPacket(2, 2));
    const overflowState = watchPromise(overflow);
    await first;
    expect(pendingRtpQueue(sender)).toHaveLength(pendingLimit);
    expect(overflowState.status).toBe("pending");
    pc.close();
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

function senderStatsState(sender: RTCRtpSender) {
  return sender as unknown as {
    rtxPayloadType?: number;
    redRedundantPayloadType?: number;
  };
}

function arrangeDisconnectedSender(
  options: ConstructorParameters<typeof RTCRtpSender>[1] = {},
) {
  const track = new MediaStreamTrack({ kind: "audio" });
  const dtls = createDtlsTransport();
  const sender = new RTCRtpSender(track, {
    pendingRtp: true,
    ...options,
  });
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

describe("media/rtpSender encodings", () => {
  test("setParameters の encoding RID を RID ヘッダー拡張で送信する", async () => {
    const { sender, sendRtp } = createConnectedRtpSender({ rid: true });

    // Act: encoding に RID を設定してから RTP を送る。
    sender.setParameters({ encodings: [{ rid: "high" }] });
    await sender.sendRtp(createRtpPacket(1, 1000));

    // Assert: 送信ヘッダーに RID 拡張（id=4, "high"）が載る。
    const [header] = sentRtpHeaders(sendRtp);
    const rid = header.extensions.find((extension) => extension.id === 4);
    expect(rid?.payload.toString()).toBe("high");
    sender.stop();
  });

  test("encoding の RID は RID を含まない送信準備（SDP 交渉）後も保持される", async () => {
    const { sender, sendRtp } = createConnectedRtpSender({ rid: true });

    // Act: RID を設定した後、SDP 交渉相当の prepareSend を rtpStreamId なしで再実行する。
    sender.setParameters({ encodings: [{ rid: "high" }] });
    sender.prepareSend({
      codecs: [createAudioCodec()],
      headerExtensions: [
        new RTCRtpHeaderExtensionParameters({
          id: 4,
          uri: RTP_EXTENSION_URI.sdesRTPStreamID,
        }),
      ],
    });
    await sender.sendRtp(createRtpPacket(1, 1000));

    // Assert: RID 拡張に "high" が残る。
    const [header] = sentRtpHeaders(sendRtp);
    const rid = header.extensions.find((extension) => extension.id === 4);
    expect(rid?.payload.toString()).toBe("high");
    sender.stop();
  });
});

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

  test("送信キュー待ちの旧パケットは replaceTrack 後に送られず、新ソース先頭が連続性補正を受ける", async () => {
    const { sender, track, sendRtp } = arrangeSender();
    // Arrange: 送信キューを使う pacing 系 estimator（legacy はキューを持たない）
    attachPacedFifoEstimator(sender);
    const { release } = holdFirstDtlsWrite(sendRtp);
    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });

    // Arrange: 旧ソース 1 件目の DTLS 送信を保留し、2〜3 件目を送信キューに残す。
    track.onReceiveRtp.execute(createRtpPacket(1, 1000));
    await waitForSent(sendRtp, 1);
    track.onReceiveRtp.execute(createRtpPacket(2, 1040));
    track.onReceiveRtp.execute(createRtpPacket(3, 1080));
    const first = sentRtpHeaders(sendRtp)[0];

    // Act: キュー待ちのまま新 track へ差し替え、新ソース先頭を送ってから保留を解く。
    await sender.replaceTrack(track2);
    track2.onReceiveRtp.execute(createRtpPacket(100, 5000));
    release();
    await waitForSent(sendRtp, 2);
    await setTimeout(10);

    // Assert: 旧 2〜3 件目は送られず、新ソース先頭は保留中の旧 1 件目から seq+1 / ts+1 で続く。
    const headers = sentRtpHeaders(sendRtp);
    expect(headers).toHaveLength(2);
    expect(headers[1].sequenceNumber).toBe((first.sequenceNumber + 1) & 0xffff);
    expect(headers[1].timestamp).toBe((first.timestamp + 1) >>> 0);
  });

  test("probe 待ち中の旧パケットは replaceTrack で待ちから解除され、新ソースを遅らせない", async () => {
    const { sender, track, sendRtp } = arrangeSender({ twcc: true });
    const gcc = new GccBandwidthEstimator(300_000);
    sender.setBandwidthEstimator(gcc);
    vi.spyOn(sender, "maybeInjectProbePadding").mockResolvedValue(0);
    // Arrange: 最初の 1 件だけ 5 秒先の probe 予約を返し、media pacing は無効にする。
    let reserved = 0;
    gcc.getPacingBitrateBps = () => 0;
    gcc.shouldTagProbePacket = () => reserved === 0;
    gcc.reserveOutgoingProbe = () =>
      reserved++ === 0
        ? { clusterId: 1, nextSendTimeMs: milliTime() + 5_000 }
        : undefined;
    const track2 = new MediaStreamTrack({ kind: "audio", remote: true });

    // Act: 旧パケットを probe 待ちにさせたまま新 track へ差し替え、新ソース先頭を送る。
    track.onReceiveRtp.execute(createRtpPacket(1, 1000));
    await setTimeout(10);
    expect(sendRtp).not.toHaveBeenCalled();
    const t0 = milliTime();
    await sender.replaceTrack(track2);
    track2.onReceiveRtp.execute(createRtpPacket(100, 5000));
    await waitForSent(sendRtp, 1);

    // Assert: 新ソースは probe 待ちの終了を待たずに送られ、旧パケットは送られない。
    expect(milliTime() - t0).toBeLessThan(1_000);
    await setTimeout(20);
    expect(sendRtp).toHaveBeenCalledTimes(1);
  });

  test("pacing 待ち中に setBandwidthEstimator すると旧 estimator の待ちが解除され、新しい送信を遅らせない", async () => {
    const { sender, track, sendRtp } = arrangeSender({ twcc: true });
    vi.spyOn(sender, "maybeInjectProbePadding").mockResolvedValue(0);
    // Arrange: 旧 estimator は 80 bps の pacing（1 パケットに数秒待つ）、probe なし。
    const slow = new GccBandwidthEstimator(300_000);
    slow.getPacingBitrateBps = () => 80;
    slow.shouldTagProbePacket = () => false;
    sender.setBandwidthEstimator(slow);
    // Arrange: 新 estimator は pacing・probe なし。
    const fast = new GccBandwidthEstimator(300_000);
    fast.getPacingBitrateBps = () => 0;
    fast.shouldTagProbePacket = () => false;

    // Act: 旧 estimator の pacing 待ちに入れたまま estimator を差し替え、次のパケットを送る。
    track.onReceiveRtp.execute(createRtpPacket(1, 1000));
    await setTimeout(10);
    expect(sendRtp).not.toHaveBeenCalled();
    sender.setBandwidthEstimator(fast);
    track.onReceiveRtp.execute(createRtpPacket(2, 1040));
    // 旧待ちは 100ms 刻みで眠るため、残り約 90ms より十分短い 30ms で観測する。
    await setTimeout(30);

    // Assert: 新しい送信は旧 pacing の待ち時間（次の 100ms 刻み）を待たずに出る。
    expect(sendRtp).toHaveBeenCalledTimes(1);
    // Assert: 旧パケットはその後も送られない。
    await setTimeout(150);
    expect(sendRtp).toHaveBeenCalledTimes(1);
    expect(sentRtpHeaders(sendRtp)[0].timestamp).toBe(1040);
  });

  test("replaceTrack(null) 後は送信キュー待ちの旧パケットを送らない", async () => {
    const { sender, track, sendRtp } = arrangeSender();
    // Arrange: 送信キューを使う pacing 系 estimator（legacy はキューを持たない）
    attachPacedFifoEstimator(sender);
    const { release } = holdFirstDtlsWrite(sendRtp);

    // Arrange: 1 件目の DTLS 送信を保留し、2〜3 件目を送信キューに残す。
    track.onReceiveRtp.execute(createRtpPacket(1, 1000));
    await waitForSent(sendRtp, 1);
    const queued = [
      sender.sendRtp(createRtpPacket(2, 1040)),
      sender.sendRtp(createRtpPacket(3, 1080)),
    ];

    // Act: track を解除してから保留を解く。
    await sender.replaceTrack(null);
    release();
    await Promise.all(queued);
    await setTimeout(10);

    // Assert: 解除前に DTLS へ渡した 1 件目だけが送られ、キュー待ちの promise も解決する。
    expect(sendRtp).toHaveBeenCalledTimes(1);
    expect(sender.track).toBeNull();
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

  test("遅れて届いた重複 RTP は初回と同じ seq を使い、後続 media と衝突しない", async () => {
    const { sender, sendRtp } = arrangeSender();

    // Act: 10, 11 の後に 10 の重複が遅着し、続けて 12 を送る。
    await sender.sendRtp(createRtpPacket(10, 1000));
    await sender.sendRtp(createRtpPacket(11, 1040));
    await sender.sendRtp(createRtpPacket(10, 1000));
    await sender.sendRtp(createRtpPacket(12, 1080));

    // Assert: 重複は初回の seq を再利用し、12 は新しい seq を得る（10,11,12,12 にならない）。
    const seqs = sentRtpHeaders(sendRtp).map((header) => header.sequenceNumber);
    const base = seqs[0];
    expect(seqs).toEqual([
      base,
      (base + 1) & 0xffff,
      base,
      (base + 2) & 0xffff,
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

  test("失われた padding の NACK は RTX せず、受信側 VP8 に空 payload を流さない", async () => {
    // Arrange: VP8 + NACK/RTX。Chrome sim は NACK 無効なのでここが回帰口。
    const dtls = createDtlsTransport();
    dtls.state = "connected";
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: codecParametersToString({ apt: 96 }),
        }),
      ],
      headerExtensions: [],
    });
    const sent: { payload: Buffer; header: RtpHeader }[] = [];
    const sendRtp = vi
      .spyOn(dtls, "sendRtp")
      .mockImplementation(async (payload: Buffer, header: RtpHeader) => {
        sent.push({
          payload: Buffer.from(payload),
          header: new RtpHeader({
            ...header,
            extensions: [...header.extensions],
          }),
        });
        return payload.length + header.serializeSize;
      });
    started.push(sender);

    const { receiver, track } = createVideoReceiver({
      nack: true,
      rtx: true,
      ssrc: sender.ssrc,
      rtxSsrc: sender.rtxSsrc,
    });
    const received: { packet: RtpPacket; type?: string }[] = [];
    track.onReceiveRtp.subscribe((rtp, _ext, info) => {
      received.push({ packet: rtp, type: info?.type });
    });

    const vp8 = Buffer.from([0x10, 0x01, 0x02, 0x03]);
    await sender.sendRtp(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: 10,
          timestamp: 90000,
          payloadType: 96,
          payloadOffset: 12,
        }),
        vp8,
      ),
    );
    const mediaWire = sent[0]!;
    const mediaSeq = mediaWire.header.sequenceNumber;

    await (sender as any).sendRtpInternal(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: 0,
          timestamp: 0,
          payloadType: 96,
          marker: false,
          padding: true,
          paddingSize: kProbePaddingPacketBytes,
          payloadOffset: 12,
        }),
        Buffer.alloc(0),
      ),
      { injectProbePadding: false, isProbePadding: true },
    );
    const padSeq = sent[1]!.header.sequenceNumber;
    expect(sent[1]!.header.padding).toBe(true);

    // Act: media は届け、padding は損失したことにして NACK する
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({
          ...mediaWire.header,
          ssrc: sender.ssrc,
          padding: false,
        }),
        vp8,
      ),
      {},
    );
    sendRtp.mockClear();
    sent.length = 0;
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          lost: [padSeq],
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
        }),
      }),
    );
    await setTimeout(0);

    // Assert: padding は RTX 対象外
    expect(sendRtp).not.toHaveBeenCalled();

    // Act: 万一 RTX が出ても受信→VP8 に空 payload を流さない
    for (const pkt of sent) {
      receiver.handleRtpBySsrc(new RtpPacket(pkt.header, pkt.payload), {});
    }

    // Assert: 受信した media/retransmission は VP8 としてパースできる
    expect(received.some((r) => r.type === "retransmission")).toBe(false);
    for (const r of received) {
      if (r.type === "padding") continue;
      expect(() => dePacketizeRtpPackets("VP8", [r.packet])).not.toThrow();
      expect(r.packet.payload.length).toBeGreaterThan(0);
    }
    expect(
      received.some((r) => r.packet.header.sequenceNumber === mediaSeq),
    ).toBe(true);

    // Act: media の NACK は従来どおり RTX する
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          lost: [mediaSeq],
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
        }),
      }),
    );
    await setTimeout(0);
    expect(sendRtp).toHaveBeenCalled();
    expect(sentRtpHeaders(sendRtp)[0]!.payloadType).toBe(97);
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

  test("ソース切替後の padding は timestampOffset を重ねて適用しない", async () => {
    // Arrange: padding は RTX SSRC でだけ送るので RTX を交渉する
    const { sender, sendRtp } = arrangeSender({ rtx: true });

    // Arrange: 切替後の先頭 media timestamp が 1001 になる状態
    await sender.sendRtp(createRtpPacket(1, 1000));
    sender.replaceRTP({ sequenceNumber: 0, timestamp: 0 });
    await sender.sendRtp(createRtpPacket(0, 0));
    const mediaTs = sentRtpHeaders(sendRtp).at(-1)!.timestamp;
    expect(mediaTs).toBe(1001);
    sendRtp.mockClear();

    const sendPad = async () => {
      await (sender as any).sendRtpInternal(
        new RtpPacket(
          new RtpHeader({
            sequenceNumber: 0,
            timestamp: 0,
            payloadType: 96,
            ssrc: sender.ssrc,
            marker: false,
            padding: true,
            paddingSize: kProbePaddingPacketBytes,
            payloadOffset: 12,
          }),
          Buffer.alloc(0),
        ),
        { injectProbePadding: false, isProbePadding: true },
      );
    };

    // Act: 切替後に padding を 2 つ送る
    await sendPad();
    await sendPad();

    // Assert: 補正済み timestamp を再加算しない（旧実装は 2002, 3003）
    const pads = sentRtpHeaders(sendRtp);
    expect(pads).toHaveLength(2);
    expect(pads[0]!.timestamp).toBe(mediaTs);
    expect(pads[1]!.timestamp).toBe(mediaTs);
  });

  test("registerTrack は padding-only も develop と同じく中継する", () => {
    // Arrange: SFU 的に受信 track を sender へつなぐ
    const track = new MediaStreamTrack({ kind: "video", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    const spy = vi.spyOn(sender, "sendRtp");
    const rtp = createRtpPacket();

    // Act: padding と media を流す
    track.onReceiveRtp.execute(rtp, undefined, { type: "padding" });
    track.onReceiveRtp.execute(rtp, undefined, { type: "media" });

    // Assert: 種別で間引かず、どちらも同じ seq 変換で中継する
    expect(spy).toBeCalledTimes(2);
  });

  test("stop は DTLS state listener を解除する", () => {
    // Arrange
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender("audio");
    const unsub = vi.fn();
    dtls.onStateChange.subscribe = (() => ({
      unSubscribe: unsub,
      disposer: () => {},
    })) as typeof dtls.onStateChange.subscribe;
    sender.setDtlsTransport(dtls);

    // Act
    sender.stop();

    // Assert
    expect(unsub).toHaveBeenCalled();
  });

  test("入力 RTP の古い TWCC で新しい TSN を上書きしない", async () => {
    // Arrange
    const dtls = createDtlsTransport();
    (dtls as { state: string }).state = "connected";
    const seen: number[] = [];
    dtls.sendRtp = vi.fn(async (_p: Buffer, header: RtpHeader) => {
      const ext = header.extensions.find((e) => e.id === 3);
      if (ext) seen.push(ext.payload.readUInt16BE(0));
      return 80;
    }) as typeof dtls.sendRtp;
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
      ],
      headerExtensions: [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ],
      muxId: "0",
      rtcp: { cname: "t", mux: true },
    });

    // Act: inbound が TSN=123 を持っていても
    await sender.sendRtp(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: 1,
          timestamp: 1,
          payloadType: 96,
          ssrc: 1,
          extension: true,
          extensions: [{ id: 3, payload: serializeTransportWideCC(123) }],
        }),
        Buffer.alloc(40),
      ),
    );

    // Assert: wire は新しい TSN（1）。123 ではない
    expect(seen[0]).toBe(1);
    expect(seen[0]).not.toBe(123);
  });

  test("NACK 再送は sendRtpInternal を通り新しい TWCC seq を使う", async () => {
    // Arrange
    const dtls = createDtlsTransport();
    (dtls as { state: string }).state = "connected";
    const wireTsns: number[] = [];
    const wireSsrcs: number[] = [];
    dtls.sendRtp = vi.fn(async (_p: Buffer, header: RtpHeader) => {
      const ext = header.extensions.find((e) => e.id === 3);
      if (ext) wireTsns.push(ext.payload.readUInt16BE(0));
      wireSsrcs.push(header.ssrc);
      return 80;
    }) as typeof dtls.sendRtp;
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: "apt=96",
        }),
      ],
      headerExtensions: [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ],
      muxId: "0",
      rtcp: { cname: "t", mux: true },
    });

    await sender.sendRtp(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: 7,
          timestamp: 1000,
          payloadType: 96,
          ssrc: 1,
        }),
        Buffer.alloc(40),
      ),
    );
    const firstTsn = wireTsns[0];
    expect(firstTsn).toBeDefined();

    // Act: Generic NACK
    await sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
          lost: [7],
        }),
      }),
    );
    // NACK handler is async forEach — 再送完了を待つ
    for (let i = 0; i < 30 && wireTsns.length < 2; i++) {
      await setTimeout(5);
    }

    // Assert: 新しい TSN。元 TSN の再利用ではない。RTX SSRC
    expect(wireTsns.length).toBeGreaterThanOrEqual(2);
    expect(wireTsns[1]).not.toBe(firstTsn);
    expect(wireSsrcs[1]).toBe(sender.rtxSsrc);
  });

  test("probe next_send が 250ms 先でも 100ms で早出ししない", async () => {
    // Arrange: reserve を now+250 に固定し、実送信時刻を測る
    const gcc = new GccBandwidthEstimator(10_000);
    const dtls = createDtlsTransport();
    (dtls as { state: string }).state = "connected";
    const sendTimes: number[] = [];
    dtls.sendRtp = vi.fn(async (_p: Buffer, header: RtpHeader) => {
      sendTimes.push(milliTime());
      return 80;
    }) as typeof dtls.sendRtp;
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    sender.setBandwidthEstimator(gcc);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
        // probe padding は RTX SSRC で送る
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: "apt=96",
        }),
      ],
      headerExtensions: [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ],
      muxId: "0",
      rtcp: { cname: "t", mux: true },
    });
    const suppress = vi
      .spyOn(sender, "maybeInjectProbePadding")
      .mockResolvedValue(0);
    gcc.setNetworkAvailable(true);
    gcc.process(milliTime());
    suppress.mockRestore();
    const orig = gcc.reserveOutgoingProbe.bind(gcc);
    gcc.reserveOutgoingProbe = (nowMs: number) => {
      const r = orig(nowMs);
      if (!r) return r;
      return { ...r, nextSendTimeMs: milliTime() + 250 };
    };

    // Act
    sendTimes.length = 0;
    const t0 = milliTime();
    await sender.maybeInjectProbePadding();

    // Assert: 100ms キャップで出ていない（250ms まで待つ）
    expect(sendTimes.length).toBeGreaterThan(0);
    expect(sendTimes[0]! - t0).toBeGreaterThanOrEqual(200);
  }, 10_000);

  test("低レート probe のパケット間隔は sent_bytes/rate に近い", async () => {
    // Arrange: start=5kbps → 3x=15kbps。224B なら約 119ms
    const gcc = new GccBandwidthEstimator(5_000);
    const dtls = createDtlsTransport();
    (dtls as { state: string }).state = "connected";
    const sendTimes: number[] = [];
    dtls.sendRtp = vi.fn(async (payload: Buffer, header: RtpHeader) => {
      sendTimes.push(milliTime());
      return payload.length + header.serializeSize;
    }) as typeof dtls.sendRtp;
    const sender = new RTCRtpSender("video");
    sender.setDtlsTransport(dtls);
    sender.prepareSend({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
        }),
        // probe padding は RTX SSRC で送る
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: "apt=96",
        }),
      ],
      headerExtensions: [
        new RTCRtpHeaderExtensionParameters({
          id: 3,
          uri: RTP_EXTENSION_URI.transportWideCC,
        }),
      ],
      muxId: "0",
      rtcp: { cname: "t", mux: true },
    });
    const suppress = vi
      .spyOn(sender, "maybeInjectProbePadding")
      .mockResolvedValue(0);
    sender.setBandwidthEstimator(gcc);
    gcc.setBitrates(5_000, 5_000, 1e9);
    gcc.setNetworkAvailable(true);
    gcc.process(milliTime());
    suppress.mockRestore();
    (gcc as any).probe.queue = [];

    // Act: 先頭 2 パケット
    sendTimes.length = 0;
    await sender.maybeInjectProbePadding();

    // Assert
    expect(sendTimes.length).toBeGreaterThanOrEqual(2);
    const gap = sendTimes[1]! - sendTimes[0]!;
    const expected = (224 * 8 * 1000) / 15_000;
    expect(gap).toBeGreaterThan(expected * 0.6);
    expect(gap).toBeLessThan(expected * 1.8);
  }, 10_000);
  test("legacy は DTLS 即完了の 100 パケットバーストを欠落させず送る", async () => {
    // Arrange: 既定 (legacy) の video sender
    const { sender, sendRtp } = createConnectedRtpSender({ kind: "video" });

    // Act: 送信完了を待たず 100 パケットを同時投入
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        sender.sendRtp(createRtpPacket(i, 3000, Buffer.alloc(1200))),
      ),
    );

    // Assert: 輻輳が無いので 1 本も破棄されない
    expect(sendRtp).toHaveBeenCalledTimes(100);
  });

  test("転送では padding も source 相対の番号で中継し、欠番を作らない", async () => {
    // Arrange: 受信 track を別 sender に接続する
    const { sender, track, sendRtp } = createConnectedRtpSender({
      kind: "video",
    });

    // Act: media 1000 → padding 1001 → media 1002 を受信側 track へ流す
    track.onReceiveRtp.execute(createRtpPacket(1000, 3000, Buffer.alloc(10)));
    track.onReceiveRtp.execute(createRtpPacket(1001, 3000), undefined, {
      type: "padding",
    } as never);
    track.onReceiveRtp.execute(createRtpPacket(1002, 3000, Buffer.alloc(10)));
    await setTimeout(10);

    // Assert: padding を間引かないので番号は入力どおり連続する
    const seqs = sentRtpHeaders(sendRtp).map((h) => h.sequenceNumber);
    expect(seqs).toEqual([1000, 1001, 1002]);
    sender.stop();
  });

  test("track 切替後の先頭 padding も連続性補正を一度だけ受ける", async () => {
    // Arrange: 旧 track で 100 を送ったあと新 track へ切り替える
    const { sender, sendRtp } = createConnectedRtpSender({ kind: "video" });
    const next = new MediaStreamTrack({ kind: "video", remote: true });
    await sender.sendRtp(createRtpPacket(100, 9000, Buffer.from([1])));
    await sender.replaceTrack(next);

    // Act: 新 track は padding 1000 → media 1001 を流す
    next.onReceiveRtp.execute(createRtpPacket(1000, 9000), undefined, {
      type: "padding",
    } as never);
    next.onReceiveRtp.execute(createRtpPacket(1001, 9000, Buffer.from([2])));
    await setTimeout(10);

    // Assert: 旧 track の 100 に続けて 101, 102。番号を再利用しない
    expect(sentRtpHeaders(sendRtp).map((h) => h.sequenceNumber)).toEqual([
      100, 101, 102,
    ]);
    sender.stop();
  });

  test("padding が 300 件続いても転送番号に欠損が出ない", async () => {
    // Arrange
    const { sender, track, sendRtp } = createConnectedRtpSender({
      kind: "video",
    });
    await sender.sendRtp(createRtpPacket(1000, 3000, Buffer.from([1])));

    // Act: padding 300 件 (1001..1300) のあと media 1301
    for (let seq = 1001; seq <= 1300; seq++) {
      track.onReceiveRtp.execute(createRtpPacket(seq, 3000), undefined, {
        type: "padding",
      } as never);
    }
    await sender.sendRtp(createRtpPacket(1301, 3000, Buffer.from([2])));
    await setTimeout(10);

    // Assert: 1000..1301 が欠番なく続く
    expect(sentRtpHeaders(sendRtp).map((h) => h.sequenceNumber)).toEqual(
      Array.from({ length: 302 }, (_, i) => 1000 + i),
    );
    sender.stop();
  });

  test("legacy は DTLS 書き込みが保留中でも後続をキューに溜めず直接送る", async () => {
    // Arrange: 既定 (legacy) で 1 件目の DTLS 書き込みを保留する
    const { sender, sendRtp } = createConnectedRtpSender({ kind: "video" });
    const { release } = holdFirstDtlsWrite(sendRtp);

    // Act: 保留中に 2 件目・3 件目を送る
    const first = sender.sendRtp(createRtpPacket(1, 3000, Buffer.from([1])));
    await sender.sendRtp(createRtpPacket(2, 3000, Buffer.from([2])));
    await sender.sendRtp(createRtpPacket(3, 3000, Buffer.from([3])));

    // Assert: develop と同じく保留を待たずに DTLS へ渡す（送信キューなし）
    expect(sendRtp).toHaveBeenCalledTimes(3);
    expect((sender as any).outgoingRunning).toBe(false);
    release();
    await first;
    sender.stop();
  });
});

describe("media/rtpSender NACK retransmission over SRTP", () => {
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
    const setup = createConnectedRtpSender({ ...options, srtpLoopback: true });
    started.push(setup.sender);
    return { ...setup, srtp: setup.srtp! };
  };

  const nack = (sender: RTCRtpSender, lost: number[]) =>
    sender.handleRtcpPacket(
      new RtcpTransportLayerFeedback({
        feedback: new GenericNack({
          lost,
          senderSsrc: 1,
          mediaSourceSsrc: sender.ssrc,
        }),
      }),
    );

  test("RTX なし: 折り返し後の seq 0 再送と後続パケットが受信側で復号できる (#764)", async () => {
    const { sender, srtp } = arrangeSender();

    // Arrange: 65535 → 0..120 と送り、折り返し後の ROC=1 区間に入る。
    for (const seq of [65535, ...Array.from({ length: 121 }, (_, i) => i)]) {
      await sender.sendRtp(createRtpPacket(seq, seq * 960));
    }
    srtp.received.length = 0;

    // Act: seq 0 の NACK を受けて元 SSRC/seq のまま再送し、続けて 121 を送る。
    nack(sender, [0]);
    await setTimeout(0);
    await sender.sendRtp(createRtpPacket(121, 121 * 960));

    // Assert: 再送 0 と 121 はどちらも認証・復号に成功する。
    expect(srtp.failures).toEqual([]);
    expect(srtp.received.map((p) => p.header.sequenceNumber)).toEqual([0, 121]);
    expect(srtp.received.every((p) => p.header.ssrc === sender.ssrc)).toBe(
      true,
    );
    // Assert: 送信側の最高 index は (ROC=1, 121) で、再送で二重加算されていない。
    expect(srtp.sender.localContext.srtpSSRCStates[sender.ssrc]).toMatchObject({
      rolloverCounter: 1,
      lastSequenceNumber: 121,
    });
  });

  test("RTX あり: RTX は別 SSRC で送られ、メディア SSRC の後続パケットも復号できる", async () => {
    const { sender, srtp } = arrangeSender({ rtx: true });

    // Arrange: 65535 → 0..120 と送る。
    for (const seq of [65535, ...Array.from({ length: 121 }, (_, i) => i)]) {
      await sender.sendRtp(createRtpPacket(seq, seq * 960));
    }
    srtp.received.length = 0;

    // Act: seq 0 の NACK で RTX を送り、続けて 121 を送る。
    nack(sender, [0]);
    await setTimeout(0);
    await sender.sendRtp(createRtpPacket(121, 121 * 960));

    // Assert: 全パケットが復号でき、1 つ目は RTX SSRC の再送。
    expect(srtp.failures).toEqual([]);
    const [rtx, next] = srtp.received;
    expect(rtx.header.ssrc).toBe(sender.rtxSsrc);
    expect(unwrapRtx(rtx, 96, sender.ssrc).header.sequenceNumber).toBe(0);
    // Assert: メディア SSRC の後続 121 も復号できる。
    expect(next.header).toMatchObject({
      ssrc: sender.ssrc,
      sequenceNumber: 121,
    });
  });
});
