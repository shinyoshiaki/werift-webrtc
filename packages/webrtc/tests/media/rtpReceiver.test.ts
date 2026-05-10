import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";
import { wrapRtx } from "../../../rtp/src";
import {
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCStatsReport,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
  codecParametersToString,
  defaultPeerConfig,
} from "../../src";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { createDtlsTransport } from "../fixture";

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
    const [rtp] = await track.onReceiveRtp.asPromise();
    expect(rtp.payload).toEqual(Buffer.from([1, 2, 3, 4]));
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
});
