import { type Extension, wrapRtx } from "../../../rtp/src";
import {
  codecParametersToString,
  defaultPeerConfig,
  GenericNack,
  MediaStreamTrack,
  type PeerConfig,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  RTCRtpTransceiver,
  RTP_EXTENSION_URI,
  RtcpTransportLayerFeedback,
  RtpHeader,
  RtpPacket,
  useNACK,
  usePLI,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
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
    /** Also negotiate RED (`video/red`, {@link simulcastRedPayloadType}). */
    red?: boolean;
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
    return 0;
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
  if (options.red) {
    codecs.push(
      new RTCRtpCodecParameters({
        mimeType: "video/red",
        clockRate: 90000,
        payloadType: simulcastRedPayloadType,
      }),
    );
  }
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

/** RED payload type of {@link createSimulcastRtxReceiver} with `red`. */
export const simulcastRedPayloadType = 98;

/**
 * Arrange: RED payloads (RFC 2198) a receiver must drop. The first three do
 * not parse; the last parses but its block names payload type 127, which no
 * fixture negotiates.
 */
export const invalidRedPayloads = {
  /** No header byte at all. */
  empty: Buffer.alloc(0),
  /** F=1 without the timestamp offset and block length that must follow. */
  headerTruncated: Buffer.from([0x80]),
  /** F=1 block of PT 96 with length 100, then the primary header, 2 bytes. */
  blockTooLong: Buffer.from([0xe0, 0x00, 0x00, 0x64, 0x60, 1, 2]),
  /** A single primary block of the unnegotiated payload type 127. */
  unknownBlockPayloadType: Buffer.from([0x7f, 1, 2]),
} as const;

/** Arrange: the names of {@link invalidRedPayloads}, for `test.each`. */
export const invalidRedPayloadNames = Object.keys(
  invalidRedPayloads,
) as (keyof typeof invalidRedPayloads)[];

/**
 * Arrange: a RED packet ({@link simulcastRedPayloadType}) of a simulcast
 * layer, with the header extensions of {@link createSimulcastMediaPacket}.
 */
export function createSimulcastRedPacket(options: {
  ssrc: number;
  sequenceNumber: number;
  payload: Buffer;
  rid?: string;
  mid?: string | null;
}) {
  const packet = createSimulcastMediaPacket(options);
  packet.header.payloadType = simulcastRedPayloadType;
  return packet;
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

/**
 * Arrange: the SSRCs of a Firefox simulcast sender with two layers. Firefox
 * describes each layer's media and RTX SSRC with `a=ssrc` and
 * `a=ssrc-group:FID` besides `a=rid`, without saying which RID they carry.
 */
export const firefoxSimulcastLayers = [
  { rid: "high", ssrc: 3388294025, rtxSsrc: 1904437218 },
  { rid: "low", ssrc: 2201395340, rtxSsrc: 4017512609 },
] as const;

/**
 * Arrange: a werift peer receiving VP8 + RTX simulcast with the MID / RID /
 * repaired RID extensions in the IDs of {@link simulcastExtensionIds} and the
 * payload types of {@link createSimulcastMediaPacket} (VP8 96, RTX 97).
 */
export function createFirefoxSimulcastReceivingPeer() {
  return new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
          rtcpFeedback: [useNACK(), usePLI()],
        }),
        new RTCRtpCodecParameters({
          mimeType: "video/rtx",
          clockRate: 90000,
          payloadType: 97,
          parameters: codecParametersToString({ apt: 96 }),
        }),
      ],
      audio: [],
    },
    headerExtensions: {
      video: [useSdesMid(), useSdesRTPStreamId(), useRepairedRtpStreamId()],
      audio: [],
    },
  });
}

/**
 * Arrange: a Firefox description sending one video m-line by simulcast
 * (`a=rid:<id> send` ×2, `a=simulcast:send`, RID / repaired RID extensions)
 * that also lists each layer's media and RTX SSRC (`a=ssrc` ×4,
 * `a=ssrc-group:FID` ×2), as Firefox writes it in an offer or an answer.
 */
export function firefoxSimulcastSdp(
  options: {
    type: "offer" | "answer";
    mid?: string;
    /** Appended to each `a=rid:<id> send` line (RFC 8851 restrictions). */
    ridRestrictions?: string;
    /** false: the description omits the repaired RID extension (RFC 8852). */
    repairedRidExtension?: boolean;
  } = { type: "offer" },
) {
  const mid = options.mid ?? "0";
  const ids = simulcastExtensionIds;
  const cname = "{f9b1d5a0-4c3e-4f5e-9d2b-7a1c2e3f4a5b}";
  const [high, low] = firefoxSimulcastLayers;
  const ridSuffix = options.ridRestrictions
    ? ` ${options.ridRestrictions}`
    : "";
  return [
    "v=0",
    "o=mozilla...THIS_IS_SDPARTA-99.0 4011592410357045000 0 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "a=fingerprint:sha-256 0B:E6:4B:7C:6A:2D:3F:51:4E:8C:9A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F",
    `a=group:BUNDLE ${mid}`,
    "a=ice-options:trickle",
    "a=msid-semantic:WMS *",
    "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
    "c=IN IP4 0.0.0.0",
    "a=sendonly",
    `a=extmap:${ids.mid} ${RTP_EXTENSION_URI.sdesMid}`,
    `a=extmap:${ids.rid} ${RTP_EXTENSION_URI.sdesRTPStreamID}`,
    ...(options.repairedRidExtension === false
      ? []
      : [`a=extmap:${ids.rrid} ${RTP_EXTENSION_URI.repairedRtpStreamId}`]),
    "a=fmtp:97 apt=96",
    "a=ice-pwd:4f0bb1b0a7b8b0d2e6f3c9a1d5e7f9a1",
    "a=ice-ufrag:9a3c1d2e",
    `a=mid:${mid}`,
    "a=msid:{5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f} {0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d}",
    `a=rid:high send${ridSuffix}`,
    `a=rid:low send${ridSuffix}`,
    "a=rtcp-fb:96 nack",
    "a=rtcp-fb:96 nack pli",
    "a=rtcp-mux",
    "a=rtpmap:96 VP8/90000",
    "a=rtpmap:97 rtx/90000",
    `a=setup:${options.type === "offer" ? "actpass" : "active"}`,
    "a=simulcast:send high;low",
    `a=ssrc:${high.ssrc} cname:${cname}`,
    `a=ssrc:${high.rtxSsrc} cname:${cname}`,
    `a=ssrc:${low.ssrc} cname:${cname}`,
    `a=ssrc:${low.rtxSsrc} cname:${cname}`,
    `a=ssrc-group:FID ${high.ssrc} ${high.rtxSsrc}`,
    `a=ssrc-group:FID ${low.ssrc} ${low.rtxSsrc}`,
    "",
  ].join("\r\n");
}

/**
 * Act helper: each layer of {@link firefoxSimulcastLayers} sends media
 * 1 and 3 with its RID (2 is lost), then the RTX of 2 with its repaired RID,
 * through `route` (the receiving peer's RTP routing).
 */
export function sendFirefoxSimulcastWithRepair(
  route: (packet: RtpPacket) => void,
  mid = "0",
  { repairedRid = true }: { repairedRid?: boolean } = {},
) {
  for (const layer of firefoxSimulcastLayers) {
    for (const sequenceNumber of [1, 3]) {
      route(
        createSimulcastMediaPacket({
          ssrc: layer.ssrc,
          sequenceNumber,
          rid: layer.rid,
          mid,
        }),
      );
    }
    route(
      createSimulcastRtxFor(layer.ssrc, 2, {
        rtxSsrc: layer.rtxSsrc,
        rtxSequenceNumber: 1,
        rrid: repairedRid ? layer.rid : undefined,
        mid,
      }),
    );
  }
}

/**
 * Arrange: {@link firefoxSimulcastSdp} (offer) whose `a=ssrc` /
 * `a=ssrc-group:FID` lines are exactly `fidPairs` (`[media, rtx]`); none
 * gives a Chrome-like description without SSRCs.
 */
export function firefoxSimulcastOfferWithFid(fidPairs: [number, number][]) {
  const withoutSsrcs = firefoxSimulcastSdp({ type: "offer" })
    .split("\r\n")
    .filter((line) => !/^a=ssrc(-group)?:/.test(line))
    .join("\r\n");
  return (
    withoutSsrcs +
    fidPairs
      .flatMap(([media, rtx]) => [
        `a=ssrc:${media} cname:x`,
        `a=ssrc:${rtx} cname:x`,
        `a=ssrc-group:FID ${media} ${rtx}`,
      ])
      .concat([""])
      .join("\r\n")
  );
}

/**
 * Arrange: a {@link createFirefoxSimulcastReceivingPeer} that applied the
 * Firefox simulcast offer `sdp` and answered it. `route` feeds RTP through
 * its router, `deliveredOf(rid)` records what the RID's track delivers, and
 * `remoteOffer` applies a re-offer (answered unless `answer: false`).
 */
export async function receiveFirefoxSimulcastOffer(sdp: string) {
  const pc = createFirefoxSimulcastReceivingPeer();
  const tracks: MediaStreamTrack[] = [];
  pc.onTransceiverAdded.subscribe((transceiver) =>
    transceiver.onTrack.subscribe((track) => tracks.push(track)),
  );
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  const [transceiver] = pc.getTransceivers();
  const { router } = pc as unknown as { router: RtpRouter };
  const route = (packet: RtpPacket) =>
    router.routeRtp(packet, transceiver.dtlsTransport);
  const deliveredOf = (rid: string) =>
    collectDeliveredRtp(tracks.find((track) => track.rid === rid)!);
  const remoteOffer = async (offer: string, { answer = true } = {}) => {
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    if (answer) await pc.setLocalDescription(await pc.createAnswer());
  };
  return { pc, route, deliveredOf, remoteOffer };
}

/**
 * Arrange: a BUNDLE offer of two Firefox-style simulcast video m-lines
 * (MID "0" and "1", RIDs high / low each). MID "0" lists the FID pairs
 * `fidPairs` (media, RTX); MID "1" sends Chrome style, without `a=ssrc`.
 */
export function firefoxSimulcastBundleOfferWithFid(
  fidPairs: [number, number][],
) {
  const section = (mid: string, msid: string, pairs: [number, number][]) => {
    const lines = firefoxSimulcastSdp({ type: "offer", mid })
      .split("\r\n")
      .filter((line) => line !== "" && !/^a=ssrc(-group)?:/.test(line));
    const media = lines.slice(lines.findIndex((l) => l.startsWith("m=")));
    return media
      .map((line) => (line.startsWith("a=msid:") ? `a=msid:${msid}` : line))
      .concat(
        pairs.flatMap(([m, rtx]) => [
          `a=ssrc:${m} cname:x`,
          `a=ssrc:${rtx} cname:x`,
          `a=ssrc-group:FID ${m} ${rtx}`,
        ]),
      );
  };
  const header = firefoxSimulcastSdp({ type: "offer" })
    .split("\r\n")
    .filter((line) => line !== "");
  const session = header
    .slice(
      0,
      header.findIndex((l) => l.startsWith("m=")),
    )
    .map((line) =>
      line.startsWith("a=group:BUNDLE") ? "a=group:BUNDLE 0 1" : line,
    );
  return [
    ...session,
    ...section("0", "{s0} {t0}", fidPairs),
    ...section("1", "{s1} {t1}", []),
    "",
  ].join("\r\n");
}

/**
 * Arrange: a {@link createFirefoxSimulcastReceivingPeer} that applied the
 * BUNDLE offer `sdp` of {@link firefoxSimulcastBundleOfferWithFid} and
 * answered it. `deliveredOf(mid, rid)` records what that m-line's RID track
 * delivers, `remoteOffer` applies and answers a re-offer.
 */
export async function receiveFirefoxSimulcastBundleOffer(sdp: string) {
  const pc = createFirefoxSimulcastReceivingPeer();
  await pc.setRemoteDescription({ type: "offer", sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  const { router } = pc as unknown as { router: RtpRouter };
  const transceivers = pc.getTransceivers();
  const route = (packet: RtpPacket) =>
    router.routeRtp(packet, transceivers[0].dtlsTransport);
  const deliveredOf = (mid: string, rid: string) =>
    collectDeliveredRtp(
      transceivers
        .find((t) => t.mid === mid)!
        .receiver.tracks.find((track) => track.rid === rid)!,
    );
  const remoteOffer = async (offer: string) => {
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    await pc.setLocalDescription(await pc.createAnswer());
  };
  return { pc, router, route, deliveredOf, remoteOffer };
}

/**
 * Arrange: the m-line of {@link firefoxSimulcastSdp} sending one stream by
 * SSRC instead of RIDs (no `a=rid` / `a=simulcast`): `a=ssrc` of `media` and
 * `rtx` with their `a=ssrc-group:FID`.
 */
export function firefoxSingleStreamOfferWithFid(media: number, rtx: number) {
  return firefoxSimulcastOfferWithFid([[media, rtx]])
    .split("\r\n")
    .filter((line) => !/^a=(rid|simulcast):/.test(line))
    .join("\r\n");
}

/**
 * Arrange (acceptance): a werift peer that negotiated Firefox-style simulcast
 * ({@link firefoxSimulcastSdp}: `a=rid` ×2, `a=simulcast`, RID / repaired RID
 * extensions, `a=ssrc` ×4, `a=ssrc-group:FID` ×2) as the answerer of
 * Firefox's offer (`role: "offer"`) or the offerer Firefox answers
 * (`role: "answer"`). `announced` is what `transceiver.onTrack` gave the
 * application (one event per remote track), `ontrack` what `pc.ontrack` gave
 * (one per transceiver); `receive` feeds RTP to the receiving DTLS transport
 * as SRTP decryption would, without ICE.
 */
export async function negotiateFirefoxSimulcast(role: "offer" | "answer") {
  const pc = createFirefoxSimulcastReceivingPeer();
  const announced: MediaStreamTrack[] = [];
  const ontrack: MediaStreamTrack[] = [];
  pc.ontrack = ({ track }) => ontrack.push(track);
  const watch = (transceiver: RTCRtpTransceiver) =>
    transceiver.onTrack.subscribe((track) => announced.push(track));
  if (role === "offer") {
    pc.onTransceiverAdded.subscribe(watch);
    await pc.setRemoteDescription({
      type: "offer",
      sdp: firefoxSimulcastSdp({ type: "offer" }),
    });
    await pc.setLocalDescription(await pc.createAnswer());
  } else {
    watch(
      pc.addTransceiver("video", {
        direction: "recvonly",
        simulcast: [
          { rid: "high", direction: "recv" },
          { rid: "low", direction: "recv" },
        ],
      }),
    );
    await pc.setLocalDescription(await pc.createOffer());
    await pc.setRemoteDescription({
      type: "answer",
      sdp: firefoxSimulcastSdp({ type: "answer" }),
    });
  }
  const dtls = pc.getTransceivers()[0].receiver.dtlsTransport;
  const receive = (packet: RtpPacket) => dtls.onRtp.execute(packet);
  return { pc, announced, ontrack, receive };
}
