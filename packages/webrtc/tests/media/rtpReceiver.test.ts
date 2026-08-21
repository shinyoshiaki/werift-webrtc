import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";
import { Red, wrapRtx } from "../../../rtp/src";
import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCStatsReport,
  RTP_EXTENSION_URI,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
  RtpReceivePacketType,
  appendRfc3550Padding,
  codecParametersToString,
  defaultPeerConfig,
  kProbePaddingPacketBytes,
} from "../../src";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { createDtlsTransport } from "../fixture";
import {
  createMediaRtpPacket,
  createPaddingOnlyRtpPacket,
  createRtxRtpPacket,
  createVideoReceiver,
  defaultVideoSsrc,
  getReceiverNack,
} from "./rtpReceiverTestUtils";

describe("packages/webrtc/src/media/rtpReceiver.ts", () => {
  test("abort runRtcp", async () =>
    new Promise<void>(async (done) => {
      const dtls = createDtlsTransport();
      const receiver = new RTCRtpReceiver(defaultPeerConfig, "audio", 1234);
      receiver.setDtlsTransport(dtls);

      vi.spyOn(dtls, "sendRtcp");

      Promise.any([
        setTimeout(200).then(() => false),
        receiver.runRtcp().then(() => true),
      ]).then((res) => {
        expect(res).toBeTruthy();
        done();
      });

      await setTimeout(10);
      receiver.stop();
    }));

  test("TWCC extension が無い RTP は handleTWCC に undefined を渡さない", () => {
    // Arrange
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
        }),
      ],
      encodings: [],
      headerExtensions: [],
    });
    const handleTWCC = vi.fn();
    (
      receiver as { receiverTWCC?: { handleTWCC: typeof handleTWCC } }
    ).receiverTWCC = { handleTWCC };

    // Act
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({
          sequenceNumber: 1,
          timestamp: 1,
          payloadType: 96,
          ssrc: 1,
        }),
        Buffer.alloc(10),
      ),
      {},
    );

    // Assert
    expect(handleTWCC).not.toHaveBeenCalled();
  });

  test("handleRTP with RTX packet", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({ kind: "video" });
    track.ssrc = 777;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
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
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 96,
          rtx: { ssrc: 666 },
        }),
        new RTCRtpCodingParameters({
          ssrc: 666,
          payloadType: 97,
        }),
      ],
      headerExtensions: [],
    });

    setImmediate(() => {
      receiver.handleRtpBySsrc(
        wrapRtx(
          new RtpPacket(
            new RtpHeader({ ssrc: 777, payloadType: 96 }),
            Buffer.from([1, 2, 3, 4]),
          ),
          97,
          0,
          666,
        ),
        {},
      );
    });
    const [rtp, , info] = await track.onReceiveRtp.asPromise();
    expect(rtp.payload).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(info).toEqual({ type: RtpReceivePacketType.retransmission });
  });

  test("getStats returns report with seconds-based jitter and byte counters", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({ kind: "video", id: "remote-track" });
    track.ssrc = 777;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 96,
        }),
      ],
      headerExtensions: [],
    });

    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({
          ssrc: 777,
          payloadType: 96,
          sequenceNumber: 1,
          timestamp: 0,
        }),
        Buffer.from([1, 2, 3, 4]),
      ),
      {},
    );
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({
          ssrc: 777,
          payloadType: 96,
          sequenceNumber: 2,
          timestamp: 3000,
        }),
        Buffer.from([5, 6, 7, 8, 9]),
      ),
      {},
    );

    // Act: receiver 単位の stats を取得する。
    const report = await receiver.getStats();

    // Assert: RTCStatsReport と受信メトリクスが仕様寄りに返る。
    expect(report).toBeInstanceOf(RTCStatsReport);
    const inbound = Array.from(report.values()).find(
      (stat) => stat.type === "inbound-rtp",
    ) as any;
    expect(inbound).toBeDefined();
    expect(inbound.bytesReceived).toBe(9);
    expect(inbound.headerBytesReceived).toBeGreaterThan(0);
    expect(inbound.lastPacketReceivedTimestamp).toBeGreaterThan(
      performance.timeOrigin,
    );
    expect(inbound.jitter).toBeGreaterThanOrEqual(0);
    expect(inbound.jitter).toBeLessThan(1);

    if (inbound.transportId) {
      expect(report.has(inbound.transportId)).toBe(true);
    }
  });

  test("getStats exposes inbound root before packets arrive", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "audio", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({
      kind: "audio",
      id: "pre-receive-track",
    });
    track.ssrc = 555;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 555,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });

    // Act: 受信前の receiver から stats を取得する。
    const report = await receiver.getStats();

    // Assert: inbound-rtp root が空報告にならず、未観測カウンタは 0 で返る。
    const inbound = Array.from(report.values()).find(
      (stat) => stat.type === "inbound-rtp",
    ) as any;
    expect(inbound).toBeDefined();
    expect(inbound.trackIdentifier).toBe("pre-receive-track");
    expect(inbound.packetsReceived).toBe(0);
    expect(inbound.bytesReceived).toBe(0);
    expect(inbound.headerBytesReceived).toBe(0);
    expect(inbound.packetsLost).toBe(0);
    expect(inbound.lastPacketReceivedTimestamp).toBeUndefined();
    expect(inbound.jitter).toBeUndefined();
  });

  test("remoteTimestamp is converted to Unix epoch milliseconds", async () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "audio", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({
      kind: "audio",
      id: "remote-sr-track",
    });
    track.ssrc = 777;

    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 111,
        }),
      ],
      headerExtensions: [],
    });

    receiver.handleRtcpPacket(
      new RtcpSrPacket({
        ssrc: 777,
        senderInfo: new RtcpSenderInfo({
          ntpTimestamp: 2208988800n << 32n,
          rtpTimestamp: 0,
          packetCount: 0,
          octetCount: 0,
        }),
        reports: [],
      }),
    );

    // Act: SR を受けた後の receiver stats を取得する。
    const report = await receiver.getStats();

    // Assert: remoteTimestamp は Unix epoch ms で返る。
    const remoteOutbound = Array.from(report.values()).find(
      (stat) => stat.type === "remote-outbound-rtp",
    ) as any;
    expect(remoteOutbound).toBeDefined();
    expect(remoteOutbound.remoteTimestamp).toBe(0);
    expect(remoteOutbound.reportsSent).toBe(1);
  });

  test("padding-only is delivered as type padding with empty payload", () => {
    // Arrange
    const { receiver, track } = createVideoReceiver();
    const received: { payloadLen: number; type?: string }[] = [];
    track.onReceiveRtp.subscribe((rtp, _ext, info) => {
      received.push({ payloadLen: rtp.payload.length, type: info?.type });
    });

    // Act: deSerialize 後の padding-only を受信する
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 1 }),
      {},
    );

    // Assert: イベントは発火し payload は空、種別は padding
    expect(received).toEqual([{ payloadLen: 0, type: "padding" }]);
  });

  test("media packets are delivered as type media", () => {
    // Arrange
    const { receiver, track } = createVideoReceiver();
    let type: string | undefined;
    track.onReceiveRtp.subscribe((_rtp, _ext, info) => {
      type = info?.type;
    });

    // Act
    receiver.handleRtpBySsrc(createMediaRtpPacket({ sequenceNumber: 1 }), {});

    // Assert
    expect(type).toBe("media");
  });

  test("padding-only with TWCC extension is reported to handleTWCC", () => {
    // Arrange
    const { receiver } = createVideoReceiver();
    const handleTWCC = vi.fn();
    (
      receiver as { receiverTWCC?: { handleTWCC: typeof handleTWCC } }
    ).receiverTWCC = { handleTWCC };

    // Act: probe と同じく transport-wide seq 付き padding
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 4 }),
      {
        [RTP_EXTENSION_URI.transportWideCC]: 42,
      },
    );

    // Assert: padding を TWCC から外さない
    expect(handleTWCC).toHaveBeenCalledWith(42);
  });

  test("padding-only counts as a packet but not as payload octets", async () => {
    // Arrange
    const { receiver, track } = createVideoReceiver();

    // Act: メディア 4 バイトのあと padding-only
    receiver.handleRtpBySsrc(
      createMediaRtpPacket({
        sequenceNumber: 1,
        payload: Buffer.from([1, 2, 3, 4]),
      }),
      {},
    );
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 2 }),
      {},
    );
    const report = await receiver.getStats();

    // Assert: packets は増え、bytes は剥がし後 payload のみ
    const inbound = Array.from(report.values()).find(
      (stat) => stat.type === "inbound-rtp",
    ) as any;
    expect(inbound.packetsReceived).toBe(2);
    expect(inbound.bytesReceived).toBe(4);
    expect(track.ssrc).toBe(defaultVideoSsrc);
  });

  test("padding sequence does not look like media loss to NACK", () => {
    // Arrange: nack 付き video
    const { receiver } = createVideoReceiver({ nack: true });
    const nack = getReceiverNack(receiver);

    // Act: メディア → padding → メディア（同一 sequence 空間）
    receiver.handleRtpBySsrc(createMediaRtpPacket({ sequenceNumber: 1 }), {});
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 2 }),
      {},
    );
    receiver.handleRtpBySsrc(createMediaRtpPacket({ sequenceNumber: 3 }), {});

    // Assert: padding を欠落として扱わない
    expect(nack.lostSeqNumbers).toEqual([]);
  });

  test("padding-only under RED negotiation does not parse RED", () => {
    // Arrange: RED と Opus が両方ネゴシエーションされている
    const { receiver } = createVideoReceiver({
      kind: "audio",
      red: true,
    });
    const spy = vi.spyOn(Red, "deSerialize");

    // Act: RED PT の padding-only
    expect(() => {
      receiver.handleRtpBySsrc(
        createPaddingOnlyRtpPacket({
          sequenceNumber: 1,
          payloadType: 111,
        }),
        {},
      );
    }).not.toThrow();

    // Assert: Red.deSerialize に入らない
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("padding-only does not unmute; media does", () => {
    // Arrange
    const { receiver, track } = createVideoReceiver();
    expect(track.muted).toBe(true);

    // Act: probe だけ先に届く
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 1 }),
      {},
    );

    // Assert: padding だけでは unmute しない
    expect(track.muted).toBe(true);

    // Act: メディア到着
    receiver.handleRtpBySsrc(createMediaRtpPacket({ sequenceNumber: 2 }), {});

    // Assert
    expect(track.muted).toBe(false);
  });

  test("sender-style probe padding deSerializes then handleRTP as padding", () => {
    // Arrange: 送信直前表現（payload に RFC padding を載せた状態）
    const { receiver, track } = createVideoReceiver();
    const header = new RtpHeader({
      sequenceNumber: 9,
      timestamp: 90,
      payloadType: 96,
      ssrc: defaultVideoSsrc,
      padding: true,
      paddingSize: kProbePaddingPacketBytes,
    });
    const wirePayload = appendRfc3550Padding(
      Buffer.alloc(0),
      kProbePaddingPacketBytes,
    );
    const buf = header.serialize(header.serializeSize + wirePayload.length);
    wirePayload.copy(buf, header.payloadOffset);

    let infoType: string | undefined;
    track.onReceiveRtp.subscribe((_rtp, _ext, info) => {
      infoType = info?.type;
    });

    // Act: 受信側と同じ deSerialize → handleRTP
    const parsed = RtpPacket.deSerialize(buf);
    receiver.handleRtpBySsrc(parsed, {});

    // Assert: 正規形は空 payload + padding 種別
    expect(parsed.payload.length).toBe(0);
    expect(parsed.header.paddingSize).toBe(kProbePaddingPacketBytes);
    expect(infoType).toBe("padding");
    expect(track.muted).toBe(true);
  });

  test("RTX unwrap after padding-only still classifies retransmission", () => {
    // Arrange
    const { receiver, track } = createVideoReceiver({ rtx: true });
    const types: string[] = [];
    track.onReceiveRtp.subscribe((_rtp, _ext, info) => {
      types.push(info?.type ?? "");
    });

    // Act
    receiver.handleRtpBySsrc(
      createPaddingOnlyRtpPacket({ sequenceNumber: 1 }),
      {},
    );
    receiver.handleRtpBySsrc(
      createRtxRtpPacket(
        createMediaRtpPacket({
          sequenceNumber: 10,
          payload: Buffer.from([9, 8, 7]),
        }),
        97,
        0,
      ),
      {},
    );

    // Assert
    expect(types).toEqual(["padding", "retransmission"]);
  });
});
