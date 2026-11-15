import {
  codecParametersToString,
  defaultPeerConfig,
  GenericNack,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpSimulcastParameters,
  RTCRtpTransceiver,
  RTP_EXTENSION_URI,
  type RtcpPacket,
  RtcpReceiverInfo,
  RtcpRrPacket,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import type { RTCDtlsTransport } from "../../src/transport/dtls";
import type { Kind } from "../../src/types/domain";
import { createDtlsTransport, createPliPacket } from "../fixture";
import { createSimulcastRtxReceiver } from "./rtpReceiverTestUtils";

/**
 * Shared Arrange of the RTP routing fallback for remote m-lines without
 * `a=ssrc` (#356, RFC 9143 section 9.2): a router whose transceivers are the
 * ones created here, as the TransceiverManager wires it.
 */

/** Header extension ID of `sdes:mid` in these fixtures. */
export const ssrcLessMidExtensionId = 1;
/** Header extension ID of `sdes:rtp-stream-id` in these fixtures. */
export const ssrcLessRidExtensionId = 2;

export const opus = (payloadType = 111) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
    payloadType,
  });

export const pcmu = () =>
  new RTCRtpCodecParameters({
    mimeType: "audio/PCMU",
    clockRate: 8000,
    payloadType: 0,
  });

export const vp8 = (payloadType = 96) =>
  new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    payloadType,
  });

export const rtxOf = (payloadType: number, apt: number) =>
  new RTCRtpCodecParameters({
    mimeType: "video/rtx",
    clockRate: 90000,
    payloadType,
    parameters: codecParametersToString({ apt }),
  });

export const redOf = (payloadType: number, primary: number) =>
  new RTCRtpCodecParameters({
    mimeType: "audio/red",
    clockRate: 48000,
    channels: 2,
    payloadType,
    parameters: `${primary}/${primary}`,
  });

export function createSsrcLessRouter() {
  const router = new RtpRouter();
  const transceivers: RTCRtpTransceiver[] = [];
  router.transceivers = () => transceivers;
  const dtls = createDtlsTransport();

  /**
   * A receiving transceiver whose remote m-line sends without `a=ssrc` (as
   * setRemoteRTP() applies it): codecs prepared, no SSRC encoding, `ontrack`
   * fired. `ssrc` gives the m-line an SDP SSRC instead.
   */
  const addReceiver = (
    options: {
      kind?: Kind;
      mid?: string;
      codecs?: RTCRtpCodecParameters[];
      transport?: RTCDtlsTransport;
      ssrc?: number;
    } = {},
  ) => {
    const kind = options.kind ?? "audio";
    const codecs = options.codecs ?? [opus()];
    const transceiver = new RTCRtpTransceiver(
      kind,
      options.transport ?? dtls,
      new RTCRtpReceiver(defaultPeerConfig, kind, 1000 + transceivers.length),
      new RTCRtpSender(kind),
      "recvonly",
    );
    transceiver.mid = options.mid ?? String(transceivers.length);
    const params = {
      muxId: transceiver.mid,
      codecs,
      headerExtensions: [
        { id: ssrcLessMidExtensionId, uri: RTP_EXTENSION_URI.sdesMid },
        { id: ssrcLessRidExtensionId, uri: RTP_EXTENSION_URI.sdesRTPStreamID },
      ],
      encodings: codecs.map(
        (c) =>
          new RTCRtpCodingParameters({
            ssrc: options.ssrc as number,
            payloadType: c.payloadType,
          }),
      ),
    };
    transceiver.receiver.prepareReceive(params);
    router.registerRtpReceiverBySsrc(transceiver, params);
    transceiver.firedReceiving = true;
    transceivers.push(transceiver);
    return transceiver;
  };

  return { router, dtls, transceivers, addReceiver };
}

export function ssrcLessPacket(options: {
  ssrc: number;
  payloadType: number;
  sequenceNumber?: number;
  mid?: string;
  rid?: string;
  payload?: Buffer;
}) {
  return new RtpPacket(
    new RtpHeader({
      ssrc: options.ssrc,
      payloadType: options.payloadType,
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: (options.sequenceNumber ?? 1) * 960,
      extensions: [
        ...(options.mid === undefined
          ? []
          : [
              { id: ssrcLessMidExtensionId, payload: Buffer.from(options.mid) },
            ]),
        ...(options.rid === undefined
          ? []
          : [
              { id: ssrcLessRidExtensionId, payload: Buffer.from(options.rid) },
            ]),
      ],
    }),
    options.payload ?? Buffer.from(`payload-${options.sequenceNumber ?? 1}`),
  );
}

/**
 * An SSRC-less receiver (MID "l") and, on the same transport, a receiving
 * m-line (MID "n") that also receives the payload type `payloadType`
 * (RFC 9143 section 9.2: such a payload type names no m-line):
 * - `ssrc`: an m-line with `a=ssrc`, PT 111 (opus) as media.
 * - `rid`: an m-line receiving RID simulcast, PT 96 (VP8) as media.
 * - `rtx`: an m-line with `a=ssrc`, PT 97 as its RTX, the SSRC-less one
 *   receives PT 97 as VP8.
 */
export function createPayloadTypeSharingRouter(
  neighbor: "ssrc" | "rid" | "rtx",
) {
  const arranged = createSsrcLessRouter();
  const { router, transceivers, addReceiver } = arranged;
  if (neighbor === "rid") {
    const simulcast = createSimulcastRtxReceiver({ router, mid: "n" });
    simulcast.transceiver.firedReceiving = true;
    transceivers.push(simulcast.transceiver);
    const ssrcLess = addReceiver({
      kind: "video",
      mid: "l",
      codecs: [vp8()],
      transport: simulcast.dtls,
    });
    return {
      ...arranged,
      dtls: simulcast.dtls,
      ssrcLess,
      neighbor: simulcast.transceiver,
      payloadType: 96,
    };
  }
  if (neighbor === "rtx") {
    const other = addReceiver({
      kind: "video",
      mid: "n",
      codecs: [vp8(), rtxOf(97, 96)],
      ssrc: 9000,
    });
    const ssrcLess = addReceiver({
      kind: "video",
      mid: "l",
      codecs: [vp8(97)],
    });
    return { ...arranged, ssrcLess, neighbor: other, payloadType: 97 };
  }
  const other = addReceiver({ mid: "n", codecs: [opus()], ssrc: 9000 });
  const ssrcLess = addReceiver({ mid: "l", codecs: [opus(), pcmu()] });
  return { ...arranged, ssrcLess, neighbor: other, payloadType: 111 };
}

/** The payloads `transceiver`'s announced track (`receiver.track`) received. */
export function collectTrackPayloads(transceiver: RTCRtpTransceiver) {
  const payloads: string[] = [];
  transceiver.receiver.track.onReceiveRtp.subscribe((rtp) => {
    payloads.push(rtp.payload.toString());
  });
  return payloads;
}

/**
 * Two transports (separate RTP sessions) whose SSRC-less receivers both
 * learned the same numeric SSRC: `a` on `dtls` first, then `b` on `other`.
 */
export function createCollidingSsrcLessRouter(ssrc = 55) {
  const arranged = createSsrcLessRouter();
  const { router, dtls, addReceiver } = arranged;
  const other = createDtlsTransport();
  const a = addReceiver({ mid: "a" });
  const b = addReceiver({ mid: "b", transport: other });
  router.routeRtp(ssrcLessPacket({ ssrc, payloadType: 111, mid: "a" }), dtls);
  router.routeRtp(ssrcLessPacket({ ssrc, payloadType: 111, mid: "b" }), other);
  return { ...arranged, other, a, b };
}

/** RTCP packets that name `ssrc` as the stream they report on or ask for. */
export const rtcpNamingSsrc: Record<string, (ssrc: number) => RtcpPacket> = {
  SR: (ssrc) =>
    new RtcpSrPacket({
      ssrc,
      senderInfo: new RtcpSenderInfo({
        ntpTimestamp: 1n << 32n,
        rtpTimestamp: 0,
        packetCount: 1,
        octetCount: 1,
      }),
    }),
  RR: (ssrc) =>
    new RtcpRrPacket({
      ssrc: 1,
      reports: [
        new RtcpReceiverInfo({
          ssrc,
          fractionLost: 0,
          packetsLost: 0,
          highestSequence: 0,
          jitter: 0,
          lsr: 0,
          dlsr: 0,
        }),
      ],
    }),
  NACK: (ssrc) =>
    new RtcpTransportLayerFeedback({
      feedback: new GenericNack({
        senderSsrc: 1,
        mediaSourceSsrc: ssrc,
        lost: [1],
      }),
    }),
  PLI: (ssrc) => createPliPacket({ senderSsrc: 1, mediaSsrc: ssrc }),
};

/** Labels of the transceivers whose receiver got an RTCP packet, in order. */
export function collectRtcpRecipients(
  transceivers: Record<string, RTCRtpTransceiver>,
) {
  const recipients: string[] = [];
  for (const [label, transceiver] of Object.entries(transceivers)) {
    transceiver.receiver.onRtcp.subscribe(() => recipients.push(label));
  }
  return recipients;
}

/** Number of same-SSRC routes of other RTP sessions the router holds. */
export function collidingRouteCount(router: RtpRouter) {
  const routes = (
    router as unknown as { collidingRoutes: Map<unknown, { size: number }> }
  ).collidingRoutes;
  return [...routes.values()].reduce((sum, set) => sum + set.size, 0);
}

/** SSRCs of the `inbound-rtp` statistics `transceiver`'s receiver reports. */
export async function inboundRtpSsrcs(transceiver: RTCRtpTransceiver) {
  const stats = [...(await transceiver.receiver.getStats()).values()];
  return stats
    .filter((s) => s.type === "inbound-rtp")
    .map((s) => (s as { ssrc?: number }).ssrc);
}

/**
 * A receiving SSRC-less m-line whose current session learned `ssrc` and to
 * which a pending re-offer gives the RID "high" (staged until the commit).
 */
export function createPendingRidOverFallback(ssrc: number) {
  const arranged = createSsrcLessRouter();
  const { router, dtls, addReceiver } = arranged;
  const audio = addReceiver();
  audio.setCurrentDirection("recvonly");
  const announced = audio.receiver.track;
  router.routeRtp(
    ssrcLessPacket({ ssrc, payloadType: 111, sequenceNumber: 1 }),
    dtls,
  );
  const routes = router.snapshotRoutes();
  const receiverState = audio.receiver.snapshotNegotiationState();
  router.registerRtpReceiverByRid(
    audio,
    new RTCRtpSimulcastParameters({ rid: "high", direction: "send" }),
    { codecs: [opus()], headerExtensions: [], encodings: [] },
    { deferConflicts: true },
  );
  /** Rollback in the order `NegotiationTransaction` restores: receivers, then routes. */
  const rollback = () => {
    audio.receiver.restoreNegotiationState(receiverState);
    router.restoreRoutes(routes, {
      endpoints: new Set([audio.receiver, audio.sender]),
      liveSenders: [],
    });
  };
  return { ...arranged, audio, announced, rollback };
}
