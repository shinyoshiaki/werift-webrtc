import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";
import {
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
