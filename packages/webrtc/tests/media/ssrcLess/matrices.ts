import {
  RTCRtpCodingParameters,
  type RTCRtpTransceiver,
  type RtcpPacket,
  RtcpTransportLayerFeedback,
  TransportWideCC,
} from "../../../src";
import type { RTCRtpReceiver } from "../../../src/media/rtpReceiver";
import { RTCRtpSender } from "../../../src/media/rtpSender";
import type { RTCDtlsTransport } from "../../../src/transport/dtls";
import { createDtlsTransport } from "../../fixture";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
} from "../rtpReceiverTestUtils";
import {
  createSsrcLessRouter,
  opus,
  rtcpNamingSsrc,
  ssrcLessPacket,
} from "./arrange";

/**
 * Shared Arrange of the combination tables of #356: the route matrix (3.11,
 * the endpoints that may name one SSRC) and the identifier matrix (3.12, every
 * identifier resolves within the RTP session of the packet).
 */

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
