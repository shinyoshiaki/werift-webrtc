import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";
import {
  GccBandwidthEstimator,
  GenericNack,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
  RTP_EXTENSION_URI,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  serializeTransportWideCC,
} from "../../src";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { RTCStatsReport } from "../../src/media/stats";
import { milliTime } from "../../src/utils";
import { createDtlsTransport, createRtpPacket } from "../fixture";

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

  test("registerTrack does not relay padding-only packets", () => {
    // Arrange: SFU 的に受信 track を sender へつなぐ
    const track = new MediaStreamTrack({ kind: "video", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    const spy = vi.spyOn(sender, "sendRtp");
    const rtp = createRtpPacket();

    // Act: padding 種別は再送しない
    track.onReceiveRtp.execute(rtp, undefined, { type: "padding" });

    // Assert
    expect(spy).not.toHaveBeenCalled();

    // Act: メディアは従来どおり送る
    track.onReceiveRtp.execute(rtp, undefined, { type: "media" });

    // Assert
    expect(spy).toBeCalledTimes(1);
  });

  test("registerTrack compacts sequence numbers when skipping padding", () => {
    // Arrange: メディア seq の間に padding を挟む
    const track = new MediaStreamTrack({ kind: "video", remote: true });
    const dtls = createDtlsTransport();
    const sender = new RTCRtpSender(track);
    sender.setDtlsTransport(dtls);
    const spy = vi.spyOn(sender, "sendRtp");
    const media1 = new RtpPacket(
      new RtpHeader({ sequenceNumber: 10, payloadType: 96 }),
      Buffer.from([1]),
    );
    const padding = new RtpPacket(
      new RtpHeader({
        sequenceNumber: 11,
        payloadType: 96,
        padding: true,
      }),
      Buffer.alloc(0),
    );
    const media2 = new RtpPacket(
      new RtpHeader({ sequenceNumber: 12, payloadType: 96 }),
      Buffer.from([2]),
    );

    // Act: padding は転送せず、後続メディアの seq を詰める
    track.onReceiveRtp.execute(media1, undefined, { type: "media" });
    track.onReceiveRtp.execute(padding, undefined, { type: "padding" });
    track.onReceiveRtp.execute(media2, undefined, { type: "media" });

    // Assert: 10 の次は 11（元の 12 を uint16Add で -1）
    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0][0] as RtpPacket;
    const second = spy.mock.calls[1][0] as RtpPacket;
    expect(first.header.sequenceNumber).toBe(10);
    expect(second.header.sequenceNumber).toBe(11);
    expect(media2.header.sequenceNumber).toBe(12);
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
    setTimeout(0).then(() => track2.onReceiveRtp.execute(rtp));
    await sender.replaceTrack(track2);

    track1.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(1);

    track2.onReceiveRtp.execute(rtp);
    expect(spy).toBeCalledTimes(2);
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
