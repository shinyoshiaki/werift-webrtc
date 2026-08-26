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

    // 検証: 置換は待たず完了し、送出 RTP は 1/0 へ巻き戻らない。
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ sequenceNumber: 5000, timestamp: 900000 });
    expect(sent[1]).not.toEqual({ sequenceNumber: 1, timestamp: 0 });
    expect(sent[1].sequenceNumber).toBe(5000);
    expect(sent[1].timestamp).toBe(900000);
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
    await sender.sendRtp(createRtpPacket());
    expect(pendingRtpQueue(sender)).toHaveLength(1);
    sender.stop();
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
    await sender.sendRtp(createRtpPacket());
    expect(pendingRtpQueue(sender)).toHaveLength(1);
    await sender.replaceTrack(null);

    // 検証: 待機 RTP は破棄される。
    expect(pendingRtpQueue(sender)).toHaveLength(0);
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

function pendingRtpQueue(sender: RTCRtpSender) {
  return (sender as unknown as { pendingRtp: unknown[] }).pendingRtp;
}
