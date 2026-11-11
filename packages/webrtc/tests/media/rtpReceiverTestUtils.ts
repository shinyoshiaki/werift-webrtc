import { type Extension, wrapRtx } from "../../../rtp/src";
import {
  codecParametersToString,
  defaultPeerConfig,
  GenericNack,
  MediaStreamTrack,
  type PeerConfig,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpTransceiver,
  RTP_EXTENSION_URI,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
} from "../../src";
import { RTCRtpSimulcastParameters } from "../../src/media/parameters";
import type { NackHandler } from "../../src/media/receiver/nack";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import { createDtlsTransport } from "../fixture";

export const defaultVideoSsrc = 777;
export const defaultRtxSsrc = 666;

export function createVideoReceiver(
  options: {
    nack?: boolean;
    rtx?: boolean;
    red?: boolean;
    payloadType?: number;
    ssrc?: number;
    rtxSsrc?: number;
    kind?: "audio" | "video";
    peerConfig?: PeerConfig;
  } = {},
) {
  const kind = options.kind ?? "video";
  const payloadType = options.payloadType ?? 96;
  const ssrc = options.ssrc ?? defaultVideoSsrc;
  const rtxSsrc = options.rtxSsrc ?? defaultRtxSsrc;
  const dtls = createDtlsTransport();
  const receiver = new RTCRtpReceiver(
    options.peerConfig ?? defaultPeerConfig,
    kind,
    1234,
  );
  receiver.setDtlsTransport(dtls);

  const track = new MediaStreamTrack({ kind, remote: true });
  track.ssrc = ssrc;
  receiver.addTrack(track);

  const codecs = [
    new RTCRtpCodecParameters({
      mimeType: kind === "audio" ? "audio/opus" : "video/vp8",
      clockRate: kind === "audio" ? 48000 : 90000,
      payloadType,
      rtcpFeedback: options.nack ? [{ type: "nack" }] : [],
    }),
  ];
  const encodings = [
    new RTCRtpCodingParameters({
      ssrc,
      payloadType,
      rtx: options.rtx ? { ssrc: rtxSsrc } : undefined,
    }),
  ];

  if (options.rtx) {
    codecs.push(
      new RTCRtpCodecParameters({
        mimeType: "video/rtx",
        clockRate: 90000,
        payloadType: 97,
        parameters: codecParametersToString({ apt: payloadType }),
      }),
    );
    encodings.push(
      new RTCRtpCodingParameters({
        ssrc: rtxSsrc,
        payloadType: 97,
      }),
    );
  }

  if (options.red) {
    codecs.unshift(
      new RTCRtpCodecParameters({
        mimeType: "audio/red",
        clockRate: 48000,
        channels: 2,
        payloadType: 111,
      }),
    );
  }

  receiver.prepareReceive({
    codecs,
    encodings,
    headerExtensions: [],
  });

  return { receiver, track, dtls, payloadType, ssrc };
}

export function createMediaRtpPacket(options: {
  sequenceNumber?: number;
  timestamp?: number;
  payloadType?: number;
  ssrc?: number;
  payload?: Buffer;
  marker?: boolean;
}) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: options.timestamp ?? 1,
      payloadType: options.payloadType ?? 96,
      ssrc: options.ssrc ?? defaultVideoSsrc,
      marker: options.marker ?? false,
    }),
    options.payload ?? Buffer.from([1, 2, 3, 4]),
  );
}

export function createPaddingOnlyRtpPacket(options: {
  sequenceNumber?: number;
  timestamp?: number;
  payloadType?: number;
  ssrc?: number;
  paddingSize?: number;
}) {
  return new RtpPacket(
    new RtpHeader({
      sequenceNumber: options.sequenceNumber ?? 1,
      timestamp: options.timestamp ?? 1,
      payloadType: options.payloadType ?? 96,
      ssrc: options.ssrc ?? defaultVideoSsrc,
      padding: true,
      paddingSize: options.paddingSize ?? 224,
    }),
    Buffer.alloc(0),
  );
}

export function createRtxRtpPacket(
  media: RtpPacket,
  rtxPt = 97,
  rtxSeq = 0,
  rtxSsrc = defaultRtxSsrc,
) {
  return wrapRtx(media, rtxPt, rtxSeq, rtxSsrc);
}

export function getReceiverNack(receiver: RTCRtpReceiver) {
  return (receiver as unknown as { nack: NackHandler }).nack;
}

/** One `onReceiveRtp` delivery captured by {@link collectReceivedRtp}. */
export interface ReceivedRtp {
  seq: number;
  type?: string;
  payloadLen: number;
}

/** Arrange: record every `track.onReceiveRtp` delivery. */
export function collectReceivedRtp(track: MediaStreamTrack): ReceivedRtp[] {
  const received: ReceivedRtp[] = [];
  track.onReceiveRtp.subscribe((rtp, _ext, info) => {
    received.push({
      seq: rtp.header.sequenceNumber,
      type: info?.type,
      payloadLen: rtp.payload.length,
    });
  });
  return received;
}

/** `m<seq>` = media packet, `p<seq>` = padding-only packet. */
export type MediaOrPadding = `${"m" | "p"}${number}`;

/** Act: hand media / padding-only packets to the receiver in order. */
export function receiveMediaOrPadding(
  receiver: RTCRtpReceiver,
  packets: MediaOrPadding[],
) {
  for (const p of packets) {
    const sequenceNumber = Number(p.slice(1));
    receiver.handleRtpBySsrc(
      p[0] === "m"
        ? createMediaRtpPacket({ sequenceNumber })
        : createPaddingOnlyRtpPacket({ sequenceNumber }),
      {},
    );
  }
}

/** Header extension IDs of {@link createSimulcastRtxReceiver}. */
export const simulcastExtensionIds = { mid: 1, rid: 2, rrid: 3 } as const;

/**
 * Arrange: a recvonly video transceiver receiving RID-based simulcast (no
 * `a=ssrc` lines, as Chrome sends) with VP8 + NACK and RTX, registered on a
 * router the way `transceiverManager` does for a remote description. The
 * RTX codec is listed first so the track codec must skip it.
 */
export function createSimulcastRtxReceiver(
  options: {
    rids?: string[];
    rtx?: boolean;
    mid?: string;
    /** Register on an existing router (several m-lines sharing RIDs). */
    router?: RtpRouter;
  } = {},
) {
  const rids = options.rids ?? ["high", "low"];
  const mid = options.mid ?? "0";
  const router = options.router ?? new RtpRouter();
  const dtls = createDtlsTransport();
  const sentRtcp: unknown[] = [];
  dtls.sendRtcp = async (packets) => {
    sentRtcp.push(...packets);
    return undefined;
  };
  const transceiver = new RTCRtpTransceiver(
    "video",
    dtls,
    new RTCRtpReceiver(defaultPeerConfig, "video", 1234),
    new RTCRtpSender("video"),
    "recvonly",
  );
  transceiver.mid = mid;
  transceiver.receiver.setDtlsTransport(dtls);

  const vp8 = new RTCRtpCodecParameters({
    mimeType: "video/VP8",
    clockRate: 90000,
    payloadType: 96,
    rtcpFeedback: [{ type: "nack" }],
  });
  const rtx = new RTCRtpCodecParameters({
    mimeType: "video/rtx",
    clockRate: 90000,
    payloadType: 97,
    parameters: codecParametersToString({ apt: 96 }),
  });
  const codecs = options.rtx === false ? [vp8] : [rtx, vp8];
  const ids = simulcastExtensionIds;
  const params = {
    muxId: mid,
    codecs,
    headerExtensions: [
      { id: ids.mid, uri: RTP_EXTENSION_URI.sdesMid },
      { id: ids.rid, uri: RTP_EXTENSION_URI.sdesRTPStreamID },
      { id: ids.rrid, uri: RTP_EXTENSION_URI.repairedRtpStreamId },
    ],
    // getRemoteRtpParams(): a=ssrc がないので SSRC も RTX SSRC も空。
    encodings: [
      new RTCRtpCodingParameters({
        ssrc: undefined as unknown as number,
        payloadType: 96,
      }),
    ],
  };
  for (const rid of rids) {
    router.registerRtpReceiverByRid(
      transceiver,
      new RTCRtpSimulcastParameters({ rid, direction: "send" }),
      params,
    );
  }
  transceiver.receiver.resyncCodecs(params);
  router.registerRtpReceiverBySsrc(transceiver, params);

  const receiver = transceiver.receiver;
  const sentNacks = () =>
    sentRtcp
      .filter((p): p is RtcpTransportLayerFeedback => {
        return (
          p instanceof RtcpTransportLayerFeedback &&
          p.feedback instanceof GenericNack
        );
      })
      .map((p) => p.feedback as GenericNack);
  return { router, transceiver, receiver, dtls, sentNacks };
}

/** Arrange: header extensions in the IDs of {@link createSimulcastRtxReceiver}. */
export function simulcastExtensions(
  values: { mid?: string; rid?: string; rrid?: string } = {},
): Extension[] {
  const ids = simulcastExtensionIds;
  return (["mid", "rid", "rrid"] as const)
    .filter((key) => values[key] !== undefined)
    .map((key) => ({ id: ids[key], payload: Buffer.from(values[key]!) }));
}

/**
 * Arrange: the RTP timestamp base of `ssrc`. RFC 3550 starts each SSRC at a
 * random timestamp; a fixed hash keeps the fixtures deterministic.
 */
export function simulcastTimestampBase(ssrc: number) {
  return Math.imul(ssrc, 0x9e3779b1) >>> 0;
}

/** Arrange: a simulcast layer's media packet (VP8, PT 96). */
export function createSimulcastMediaPacket(options: {
  ssrc: number;
  sequenceNumber: number;
  rid?: string;
  /** `null` omits the MID extension. */
  mid?: string | null;
  payload?: Buffer;
  /** Defaults to the SSRC's own base + 3000 per sequence number. */
  timestamp?: number;
}) {
  return new RtpPacket(
    new RtpHeader({
      ssrc: options.ssrc,
      payloadType: 96,
      sequenceNumber: options.sequenceNumber,
      timestamp:
        options.timestamp ??
        (simulcastTimestampBase(options.ssrc) +
          options.sequenceNumber * 3000) >>>
          0,
      extensions: simulcastExtensions({
        mid: options.mid === null ? undefined : (options.mid ?? "0"),
        rid: options.rid,
      }),
    }),
    options.payload ?? Buffer.from(`media-${options.sequenceNumber}`),
  );
}

/**
 * Arrange: the RTX packet (PT 97) a browser sends to repair `media`. It
 * carries `repaired-rtp-stream-id` instead of the media's `rtp-stream-id`.
 */
export function createSimulcastRtxPacket(
  media: RtpPacket,
  options: {
    rtxSsrc: number;
    rtxSequenceNumber: number;
    rrid?: string;
    /** `null` omits the MID extension. */
    mid?: string | null;
  },
) {
  const rtx = wrapRtx(media, 97, options.rtxSequenceNumber, options.rtxSsrc);
  rtx.header.extensions = simulcastExtensions({
    mid: options.mid === null ? undefined : (options.mid ?? "0"),
    rrid: options.rrid,
  });
  return rtx;
}

/**
 * Arrange: the RTX packet on `rtxSsrc` repairing `sequenceNumber` of the
 * media SSRC `mediaSsrc` (see {@link createSimulcastRtxPacket}).
 */
export function createSimulcastRtxFor(
  mediaSsrc: number,
  sequenceNumber: number,
  options: {
    rtxSsrc: number;
    rtxSequenceNumber?: number;
    rrid?: string;
    mid?: string | null;
    timestamp?: number;
  },
) {
  return createSimulcastRtxPacket(
    createSimulcastMediaPacket({
      ssrc: mediaSsrc,
      sequenceNumber,
      timestamp: options.timestamp,
    }),
    {
      rtxSsrc: options.rtxSsrc,
      rtxSequenceNumber: options.rtxSequenceNumber ?? sequenceNumber,
      rrid: options.rrid,
      mid: options.mid,
    },
  );
}

/** Assert helper: `[ssrc, seq]` of the retransmissions in `delivered`. */
export function retransmissionsOf(
  delivered: ReturnType<typeof collectDeliveredRtp>,
) {
  return delivered
    .filter((p) => p.type === "retransmission")
    .map((p) => [p.ssrc, p.seq]);
}

/** Arrange: record `onReceiveRtp` deliveries with SSRC / PT / payload. */
export function collectDeliveredRtp(track: MediaStreamTrack) {
  const delivered: {
    ssrc: number;
    seq: number;
    payloadType: number;
    payload: string;
    type?: string;
  }[] = [];
  track.onReceiveRtp.subscribe((rtp, _ext, info) => {
    delivered.push({
      ssrc: rtp.header.ssrc,
      seq: rtp.header.sequenceNumber,
      payloadType: rtp.header.payloadType,
      payload: rtp.payload.toString(),
      type: info?.type,
    });
  });
  return delivered;
}
