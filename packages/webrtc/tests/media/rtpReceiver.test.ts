import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";
import { Red, wrapRtx } from "../../../rtp/src";
import {
  appendRfc3550Padding,
  codecParametersToString,
  defaultPeerConfig,
  kProbePaddingPacketBytes,
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
  useTWCC,
} from "../../src";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { createDtlsTransport } from "../fixture";
import {
  collectReceivedRtp,
  createMediaRtpPacket,
  createPaddingOnlyRtpPacket,
  createRtxRtpPacket,
  createVideoReceiver,
  defaultVideoSsrc,
  getReceiverNack,
  receiveMediaOrPadding,
} from "./rtpReceiverTestUtils";

const omitProbePaddingConfig = {
  ...defaultPeerConfig,
  filterProbePaddingOnReceiveRtp: true,
};

const deliverProbePaddingConfig = {
  ...defaultPeerConfig,
  filterProbePaddingOnReceiveRtp: false,
};

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

  test("resyncCodecs replaces codec map, RTX mapping, and track codec", () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({ kind: "video" });
    track.ssrc = 777;

    // Arrange: VP8 + RTX で受信準備する。
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

    // Act: H264 + 新しい RTX mapping に置換する。
    receiver.resyncCodecs({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/h264",
          clockRate: 90000,
          payloadType: 98,
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 99,
          parameters: codecParametersToString({ apt: 98 }),
        }),
      ],
      encodings: [
        new RTCRtpCodingParameters({
          ssrc: 777,
          payloadType: 98,
          rtx: { ssrc: 666 },
        }),
        new RTCRtpCodingParameters({
          ssrc: 666,
          payloadType: 99,
        }),
      ],
      headerExtensions: [],
    });

    // Assert: track の codec が更新される。
    expect(track.codec?.mimeType.toLowerCase()).toBe("video/h264");

    const received: unknown[] = [];
    track.onReceiveRtp.subscribe((rtp) => {
      received.push(rtp);
    });

    // Act: 除外された VP8 と古い RTX を受信させる。
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({ ssrc: 777, payloadType: 96 }),
        Buffer.from([1]),
      ),
      {},
    );
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({ ssrc: 666, payloadType: 97 }),
        Buffer.from([2]),
      ),
      {},
    );

    // Assert: 除外された codec は受信されない。
    expect(received).toHaveLength(0);

    // Act: 残った H264 を受信させる。
    receiver.handleRtpBySsrc(
      new RtpPacket(
        new RtpHeader({ ssrc: 777, payloadType: 98 }),
        Buffer.from([3]),
      ),
      {},
    );

    // Assert: 新しい codec は受信される。
    expect(received).toHaveLength(1);
    receiver.stop();
  });

  test("resyncCodecs reuses transport-scoped TWCC state after codec changes", () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);

    const track = new MediaStreamTrack({ kind: "video" });
    track.ssrc = 111;

    // Arrange: transport-cc ありの codec で受信準備し TWCC を開始する。
    receiver.addTrack(track);
    receiver.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
          rtcpFeedback: [useTWCC()],
        }),
      ],
      encodings: [new RTCRtpCodingParameters({ ssrc: 111, payloadType: 96 })],
      headerExtensions: [],
    });
    receiver.setupTWCC(111);
    receiver.receiverTWCC!.handleTWCC(1);
    // Arrange: 同じ DTLS transport（BUNDLE）の別 receiver も共有 TWCC を保持する。
    const bundled = new RTCRtpReceiver(defaultPeerConfig, "audio", 5678);
    bundled.setDtlsTransport(dtls);
    bundled.prepareReceive({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "audio/opus",
          clockRate: 48000,
          payloadType: 111,
          rtcpFeedback: [useTWCC()],
        }),
      ],
      encodings: [new RTCRtpCodingParameters({ ssrc: 555, payloadType: 111 })],
      headerExtensions: [],
    });
    bundled.setupTWCC(555);

    // Act: transport-cc なしの codec と新しい SSRC に再同期する。
    receiver.resyncCodecs(
      {
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/h264",
            clockRate: 90000,
            payloadType: 98,
          }),
        ],
        encodings: [new RTCRtpCodingParameters({ ssrc: 222, payloadType: 98 })],
        headerExtensions: [],
      },
      222,
    );

    // Assert: codec で transport-cc が無効なら、この receiver は TWCC を使わない。
    expect(receiver.receiverTWCC).toBeUndefined();

    // Act: transport-cc ありの codec とさらに新しい SSRC に再同期する。
    receiver.resyncCodecs(
      {
        codecs: [
          new RTCRtpCodecParameters({
            mimeType: "video/vp8",
            clockRate: 90000,
            payloadType: 96,
            rtcpFeedback: [useTWCC()],
          }),
        ],
        encodings: [new RTCRtpCodingParameters({ ssrc: 333, payloadType: 96 })],
        headerExtensions: [],
      },
      333,
    );

    // Assert: transport-wide 履歴は codec 再交渉をまたいで共有される。
    expect(receiver.receiverTWCC).toBeDefined();
    expect(receiver.receiverTWCC).toBe(bundled.receiverTWCC);
    expect(Object.keys(receiver.receiverTWCC!.extensionInfo)).toContain("1");
    receiver.stop();
    bundled.stop();
  });

  test("resyncCodecs を繰り返しても共有 TWCC の参照は増えず、stop で定期処理が止まる", () => {
    const dtls = createDtlsTransport();
    const receiver = new RTCRtpReceiver(defaultPeerConfig, "video", 1234);
    receiver.setDtlsTransport(dtls);
    const params = (ssrc: number) => ({
      codecs: [
        new RTCRtpCodecParameters({
          mimeType: "video/vp8",
          clockRate: 90000,
          payloadType: 96,
          rtcpFeedback: [useTWCC()],
        }),
      ],
      encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 96 })],
      headerExtensions: [],
    });

    // Arrange: transport-cc ありで受信準備し、共有 TWCC を取得する。
    receiver.prepareReceive(params(111));
    receiver.setupTWCC(111);
    const twcc = receiver.receiverTWCC!;

    // Act: 再交渉相当の resyncCodecs を複数回実行してから stop する。
    receiver.resyncCodecs(params(222), 222);
    receiver.resyncCodecs(params(333), 333);
    receiver.resyncCodecs(params(444), 444);
    const shared = receiver.receiverTWCC;
    receiver.stop();

    // Assert: 同じ transport の共有インスタンスが使われ、最後の解放で 100ms 定期処理が止まる。
    expect(shared).toBe(twcc);
    expect(twcc.twccRunning).toBe(false);
    expect(receiver.receiverTWCC).toBeUndefined();
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

  test.each([
    { config: "既定", peerConfig: undefined },
    { config: "filter false", peerConfig: deliverProbePaddingConfig },
  ])(
    "$config では padding-only も wire の seq のまま type padding で届く",
    ({ peerConfig }) => {
      // Arrange: filterProbePaddingOnReceiveRtp の既定は false
      const { receiver, track } = createVideoReceiver({ peerConfig });
      const received = collectReceivedRtp(track);

      // Act: media → padding → media
      receiveMediaOrPadding(receiver, ["m10", "p11", "m12"]);

      // Assert: seq は補正せず、padding は空 payload の type padding
      expect(received).toEqual([
        { seq: 10, type: "media", payloadLen: 4 },
        { seq: 11, type: "padding", payloadLen: 0 },
        { seq: 12, type: "media", payloadLen: 4 },
      ]);
    },
  );

  // filter 有効時の seq の詰め（遅延・重複・wrap を含む）は tests/pbt/receiver の性質テストで確かめる。

  test("padding-only は TWCC・packet 数には数え、media としては扱わない", async () => {
    // Arrange: NACK + RTX 付き video。TWCC の受信は mock で観察する
    const { receiver, track } = createVideoReceiver({ nack: true, rtx: true });
    const handleTWCC = vi.fn();
    (
      receiver as { receiverTWCC?: { handleTWCC: typeof handleTWCC } }
    ).receiverTWCC = { handleTWCC };
    const received = collectReceivedRtp(track);
    // Arrange: sender と同じ送信直前表現（payload に RFC 3550 padding を載せた wire）
    const header = new RtpHeader({
      sequenceNumber: 1,
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
    const wire = header.serialize(header.serializeSize + wirePayload.length);
    wirePayload.copy(wire, header.payloadOffset);

    // Act: probe（TWCC seq 42 付き padding-only）だけが先に届く
    const probe = RtpPacket.deSerialize(wire);
    receiver.handleRtpBySsrc(probe, {
      [RTP_EXTENSION_URI.transportWideCC]: 42,
    });

    // Assert: 受信側の正規形は空 payload。TWCC には報告するが、padding だけでは unmute しない
    expect(probe.payload.length).toBe(0);
    expect(probe.header.paddingSize).toBe(kProbePaddingPacketBytes);
    expect(handleTWCC).toHaveBeenCalledWith(42);
    expect(track.muted).toBe(true);

    // Act: media → padding → media → RTX
    receiveMediaOrPadding(receiver, ["m2", "p3", "m4"]);
    receiver.handleRtpBySsrc(
      createRtxRtpPacket(createMediaRtpPacket({ sequenceNumber: 2 }), 97, 0),
      {},
    );

    // Assert: media で unmute し、RTX は padding の後でも retransmission
    expect(track.muted).toBe(false);
    expect(received.map((r) => r.type)).toEqual([
      "padding",
      "media",
      "padding",
      "media",
      "retransmission",
    ]);
    // Assert: padding の seq は NACK の欠落に見えない
    expect(getReceiverNack(receiver).lostSeqNumbers).toEqual([]);
    // Assert: packets には padding も数え、bytes は剥がし後の media payload だけ
    const inbound = Array.from((await receiver.getStats()).values()).find(
      (stat) => stat.type === "inbound-rtp",
    ) as any;
    expect(inbound.packetsReceived).toBe(4);
    expect(inbound.bytesReceived).toBe(8);
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

  test("BUNDLE の複数 receiver は同一 DTLS の ReceiverTWCC を共有する", () => {
    // Arrange
    const dtls = createDtlsTransport();
    const codec = new RTCRtpCodecParameters({
      mimeType: "video/vp8",
      clockRate: 90000,
      payloadType: 96,
      rtcpFeedback: [{ type: "transport-cc" }],
    });
    const audio = new RTCRtpReceiver(defaultPeerConfig, "audio", 1);
    const video = new RTCRtpReceiver(defaultPeerConfig, "video", 2);
    audio.setDtlsTransport(dtls);
    video.setDtlsTransport(dtls);
    const params = {
      codecs: [codec],
      encodings: [],
      headerExtensions: [],
    };
    audio.prepareReceive(params);
    video.prepareReceive(params);

    // Act
    audio.setupTWCC(100);
    video.setupTWCC(200);

    // Assert
    expect(audio.receiverTWCC).toBeDefined();
    expect(audio.receiverTWCC).toBe(video.receiverTWCC);
    audio.receiverTWCC!.twccRunning = false;
  });
});
