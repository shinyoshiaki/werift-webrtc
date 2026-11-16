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
  TransportWideCC,
} from "../../src";
import { RtpRouter } from "../../src/media/router";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../src/media/rtpSender";
import type { RTCDtlsTransport } from "../../src/transport/dtls";
import type { Kind } from "../../src/types/domain";
import { createDtlsTransport, createPliPacket } from "../fixture";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
} from "./rtpReceiverTestUtils";

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

/** RTCP packet types a local sender got, in order (its handler is replaced). */
export function collectSenderRtcp(sender: RTCRtpSender) {
  const types: number[] = [];
  sender.handleRtcpPacket = ((packet: RtcpPacket) => {
    types.push(packet.type);
  }) as RTCRtpSender["handleRtcpPacket"];
  return types;
}

/** `origin:label` of every route of `ssrc`, labelled by endpoint. */
export function routeLabels(
  router: RtpRouter,
  ssrc: number,
  labels: Record<string, RTCRtpReceiver | RTCRtpSender>,
) {
  return router.routeEntries
    .filter((route) => route.ssrc === ssrc)
    .map((route) => {
      const label =
        Object.entries(labels).find(
          ([, endpoint]) => endpoint === route.endpoint,
        )?.[0] ?? "?";
      return `${route.origin}:${label}`;
    });
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

/** An endpoint kind of the route matrix (#356 3.11): a local sender, an SDP receiver, a learning receiver. */
export type RouteKind = "sender" | "sdp" | "learned";

/**
 * Arrange of the route matrix (#356 3.11): two endpoints `first` and
 * `second` that name one SSRC, on the same transport or on two, registered
 * in that order by `register()`. A `learned` end is an SSRC-less receiver
 * that learns the SSRC from a packet with its MID, an `sdp` end a receiver
 * an answer gives the SSRC, a `sender` end a local sender whose SSRC it is.
 * `probe()` sends, on each transport, SR, RR, NACK, PLI and TWCC feedback
 * naming the SSRC, then one RTP packet without MID, and returns what each
 * end got.
 */
export function createRouteMatrix({
  first,
  second,
  sameTransport,
}: {
  first: RouteKind;
  second: RouteKind;
  sameTransport: boolean;
}) {
  const arranged = createSsrcLessRouter();
  const { router, dtls, addReceiver } = arranged;
  const transports = [dtls, sameTransport ? dtls : createDtlsTransport()];
  const sender =
    first === "sender" || second === "sender"
      ? new RTCRtpSender("audio")
      : undefined;
  const ssrc = sender?.ssrc ?? 55;
  type End = {
    label: "first" | "second";
    kind: RouteKind;
    transport: RTCDtlsTransport;
    transceiver?: RTCRtpTransceiver;
    sender?: RTCRtpSender;
  };
  const ends: End[] = [first, second].map((kind, index) => {
    const label = index === 0 ? "first" : "second";
    const transport = transports[index];
    if (kind === "sender") {
      sender!.dtlsTransport = transport;
      return { label, kind, transport, sender };
    }
    const transceiver = addReceiver({ mid: label, transport });
    return { label, kind, transport, transceiver };
  });
  const got = new Map<string, string[]>(ends.map((e) => [e.label, []]));
  for (const end of ends) {
    const record = (what: string) => got.get(end.label)!.push(what);
    if (end.sender) {
      end.sender.handleRtcpPacket = ((packet: RtcpPacket) => {
        record(`rtcp:${packet.type}`);
      }) as RTCRtpSender["handleRtcpPacket"];
    } else {
      const receiver = end.transceiver!.receiver;
      receiver.track.onReceiveRtp.subscribe((rtp) =>
        record(`rtp:${rtp.payload.toString()}`),
      );
      receiver.onRtcp.subscribe((packet) => record(`rtcp:${packet.type}`));
    }
  }
  let sequenceNumber = 0;
  const register = () => {
    for (const end of ends) {
      if (end.kind === "sender") {
        router.registerRtpSender(end.sender!);
      } else if (end.kind === "sdp") {
        router.registerRtpReceiverBySsrc(end.transceiver!, {
          codecs: [opus()],
          headerExtensions: [],
          encodings: [new RTCRtpCodingParameters({ ssrc, payloadType: 111 })],
        });
      } else {
        router.routeRtp(
          ssrcLessPacket({
            ssrc,
            payloadType: 111,
            mid: end.label,
            sequenceNumber: ++sequenceNumber,
            payload: Buffer.from(`learn-${end.label}`),
          }),
          end.transport,
        );
      }
    }
    for (const list of got.values()) list.length = 0;
  };
  const distinct = [...new Set(transports)];
  const probe = () => {
    // RTCP を先に流す (RTP が経路を学習し直す前の状態を確かめる)。
    for (const transport of distinct) {
      for (const packet of [
        rtcpNamingSsrc.SR(ssrc),
        rtcpNamingSsrc.RR(ssrc),
        rtcpNamingSsrc.NACK(ssrc),
        rtcpNamingSsrc.PLI(ssrc),
        twccFeedback(ssrc),
      ]) {
        router.routeRtcp(packet, transport);
      }
    }
    for (const [index, transport] of distinct.entries()) {
      router.routeRtp(
        ssrcLessPacket({
          ssrc,
          payloadType: 111,
          sequenceNumber: 100 + ++sequenceNumber,
          payload: Buffer.from(`t${index}`),
        }),
        transport,
      );
    }
    return Object.fromEntries(got);
  };
  return { ...arranged, ends, ssrc, transports: distinct, register, probe };
}

/** A transport-wide CC feedback whose media source SSRC is `ssrc`. */
function twccFeedback(ssrc: number) {
  return new RtcpTransportLayerFeedback({
    feedback: new TransportWideCC({
      senderSsrc: 1,
      mediaSourceSsrc: ssrc,
      baseSequenceNumber: 0,
      packetStatusCount: 0,
      referenceTime: 0,
      fbPktCount: 0,
    }),
  });
}

/**
 * The expected result of the route matrix: per transport the end that wins
 * the SSRC there — a local sender over an SDP receiver over a learning one
 * in one RTP session (the later of two of a kind), each transport its own
 * across transports. A sender gets the RTCP of its
 * transport (TWCC too) and no RTP; a receiver gets its transport's RTP and
 * RTCP; a learning end that loses forgets the SSRC.
 */
export function expectedRouteMatrix(
  ends: { label: string; kind: RouteKind; transport: RTCDtlsTransport }[],
  transports: RTCDtlsTransport[],
) {
  const rank = { sender: 3, sdp: 2, learned: 1 } as const;
  const winners = transports.map((transport) => {
    const here = ends.filter((e) => e.transport === transport);
    return here.reduce<(typeof here)[number] | undefined>(
      (best, e) => (!best || rank[e.kind] >= rank[best.kind] ? e : best),
      undefined,
    );
  });
  const got: Record<string, string[]> = Object.fromEntries(
    ends.map((e) => [e.label, [] as string[]]),
  );
  for (const [index, transport] of transports.entries()) {
    const winner = winners[index];
    for (const type of [200, 201, 205, 206]) {
      if (winner) got[winner.label].push(`rtcp:${type}`);
    }
    for (const e of ends) {
      if (e.kind === "sender" && e.transport === transport) {
        got[e.label].push("rtcp:205");
      }
    }
  }
  for (const [index] of transports.entries()) {
    const winner = winners[index];
    if (winner && winner.kind !== "sender") {
      got[winner.label].push(`rtp:t${index}`);
    }
  }
  const keeps = Object.fromEntries(
    ends
      .filter((e) => e.kind === "learned")
      .map((e) => [e.label, winners.includes(e)]),
  );
  return { got, keeps };
}

/** An identifier kind of the identifier matrix (#356 3.12). */
export type IdentifierKind = "rid" | "rrid" | "learned" | "sdp";

/**
 * Arrange of the identifier matrix (#356 3.12): on transport A an SSRC-less
 * receiver `a` (Opus, MID `a`), on transport B a simulcast receiver `s`
 * (VP8 + RTX, RID `high`, MID `s`) and a receiver `n` an answer gave SSRC
 * 600 (Opus, MID `n`); `a` has learned SSRC 500. `send(kind, mid, transport)`
 * sends one packet of the identifier — a RID media packet (SSRC 55), an RTX
 * packet naming the RID (SSRC 77), or an RTP packet of the learned (500) or
 * SDP (600) SSRC — with the MID extension `mid` (or none) on `transport`,
 * then an SR, a NACK and a PLI naming its SSRC on the same transport, and
 * returns which receiver took it and which got the RTCP.
 */
export function createIdentifierMatrix() {
  const arranged = createSsrcLessRouter();
  const { router, dtls: transportA, transceivers, addReceiver } = arranged;
  const a = addReceiver({ mid: "a" });
  a.setCurrentDirection("recvonly");
  const simulcast = createSimulcastRtxReceiver({ router, mid: "s" });
  const s = simulcast.transceiver;
  s.firedReceiving = true;
  s.setCurrentDirection("recvonly");
  transceivers.push(s);
  const transportB = simulcast.dtls;
  const n = addReceiver({ mid: "n", transport: transportB });
  n.setCurrentDirection("recvonly");
  router.registerRtpReceiverBySsrc(n, {
    codecs: [opus()],
    headerExtensions: [],
    encodings: [new RTCRtpCodingParameters({ ssrc: 600, payloadType: 111 })],
  });
  router.routeRtp(
    ssrcLessPacket({
      ssrc: 500,
      payloadType: 111,
      mid: "a",
      sequenceNumber: 1,
    }),
    transportA,
  );
  const ssrcOf: Record<IdentifierKind, number> = {
    rid: 55,
    rrid: 77,
    learned: 500,
    sdp: 600,
  };
  const labels = new Map<RTCRtpReceiver, string>([
    [a.receiver, "a"],
    [s.receiver, "s"],
    [n.receiver, "n"],
  ]);
  const send = (
    kind: IdentifierKind,
    mid: string | undefined,
    transport: RTCDtlsTransport,
  ) => {
    const ssrc = ssrcOf[kind];
    const taken: string[] = [];
    const rtcp: string[] = [];
    const subscriptions = [a, s, n].map((t) => {
      const label = labels.get(t.receiver)!;
      const tracks = [
        t.receiver.track,
        ...Object.values(t.receiver.trackByRID),
      ];
      return [
        ...tracks.map((track) =>
          track.onReceiveRtp.subscribe(() => taken.push(label)),
        ),
        t.receiver.onRtcp.subscribe(() => rtcp.push(label)),
      ];
    });
    const before = {
      rtx: { ...s.receiver.ridByRtxSsrc },
      media: { ...s.receiver.mediaSsrcByRid },
      fallback: a.receiver.fallbackSsrcs,
    };
    if (kind === "rid") {
      router.routeRtp(
        createSimulcastMediaPacket({
          ssrc,
          sequenceNumber: 1,
          rid: "high",
          mid: mid ?? null,
        }),
        transport,
      );
    } else if (kind === "rrid") {
      router.routeRtp(
        createSimulcastRtxPacket(
          createSimulcastMediaPacket({
            ssrc: 2000,
            sequenceNumber: 1,
            mid: null,
          }),
          {
            rtxSsrc: ssrc,
            rtxSequenceNumber: 1,
            rrid: "high",
            mid: mid ?? null,
          },
        ),
        transport,
      );
    } else {
      router.routeRtp(
        ssrcLessPacket({ ssrc, payloadType: 111, mid, sequenceNumber: 10 }),
        transport,
      );
    }
    // RTX は track に届かないので、RID の RTX として結び付いたことで受けたとみなす。
    if (
      s.receiver.ridByRtxSsrc[ssrc] !== undefined &&
      before.rtx[ssrc] === undefined
    ) {
      taken.push("s");
    }
    for (const packet of [
      rtcpNamingSsrc.SR(ssrc),
      rtcpNamingSsrc.NACK(ssrc),
      rtcpNamingSsrc.PLI(ssrc),
    ]) {
      router.routeRtcp(packet, transport);
    }
    for (const list of subscriptions) for (const sub of list) sub.unSubscribe();
    const routes = router.routeEntries
      .filter((r) => r.ssrc === ssrc)
      .map((r) => ({
        label: labels.get(r.endpoint as RTCRtpReceiver),
        transport: r.endpoint.dtlsTransport,
      }));
    return {
      taken: [...new Set(taken)],
      rtcp: [...new Set(rtcp)],
      routes,
      before,
    };
  };
  return {
    ...arranged,
    transportA,
    transportB,
    a,
    s,
    n,
    send,
  };
}
