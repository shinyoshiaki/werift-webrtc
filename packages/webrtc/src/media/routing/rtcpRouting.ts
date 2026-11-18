import {
  type CompatibilityOptionValue,
  CompatibilityOptionValues,
} from "../../api/compatibilityOptions";
import {
  FullIntraRequest,
  PictureLossIndication,
  ReceiverEstimatedMaxBitrate,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  TransportWideCC,
} from "../../imports/rtp";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { RTCRtpReceiver } from "../rtpReceiver";
import type { RTCRtpSender } from "../rtpSender";
import { type Endpoint, sameSession } from "./routeTable";

/**
 * Where a keyframe request (PLI / FIR) goes when no route has its target SSRC.
 * - `"fallback"` (default): the sender whose RTX SSRC it is, else the only
 *   video sender, so that a request naming the RTX stream, SSRC 0 or a
 *   stale SSRC still gets a keyframe. Only senders of the request's RTP
 *   session (its DTLS transport) are candidates.
 * - `"standard"`: not delivered (RFC 4585 section 6.1 / RFC 5104 section 4.3.1).
 *
 * A registered target SSRC is routed as is in both modes, and the sender SSRC
 * of the request is never used: it names the requesting peer's own stream.
 * `PeerConfig.keyFrameRequestRouting` also accepts the names up to v0.27.0
 * (`"compatible"` for `"fallback"`, `"strict"` for `"standard"`).
 */
export type KeyFrameRequestRouting =
  CompatibilityOptionValue<"keyFrameRequestRouting">;

export const KeyFrameRequestRoutingModes: readonly KeyFrameRequestRouting[] =
  CompatibilityOptionValues.keyFrameRequestRouting;

type FirEntry = FullIntraRequest["fir"][number];

/** What RTCP routing reads from the router. */
export type RtcpRoutingContext = {
  /** The endpoint `ssrc` names in the RTP session of `transport`. */
  endpointBySsrc: (
    ssrc: number,
    transport?: RTCDtlsTransport,
  ) => Endpoint | undefined;
  /** The endpoint of every route, in route order (senders are read from it). */
  endpoints: () => Endpoint[];
  keyFrameRequestRouting: KeyFrameRequestRouting;
};

/**
 * Deliver an RTCP packet to the endpoints it names in the RTP session of
 * `transport`: SR / RR / REMB / NACK and other feedback by SSRC, transport-cc
 * to every sender of the transport, PLI / FIR to the media source
 * ({@link KeyFrameRequestRouting}).
 */
export function routeRtcp(
  packet: RtcpPacket,
  transport: RTCDtlsTransport | undefined,
  ctx: RtcpRoutingContext,
) {
  const recipients: (Endpoint | undefined)[] = [];

  switch (packet.type) {
    case RtcpSrPacket.type:
      {
        const sr = packet as RtcpSrPacket;
        recipients.push(ctx.endpointBySsrc(sr.ssrc, transport));
      }
      break;
    case RtcpRrPacket.type:
      {
        const rr = packet as RtcpRrPacket;
        rr.reports.forEach((report) => {
          recipients.push(ctx.endpointBySsrc(report.ssrc, transport));
        });
      }
      break;
    case RtcpSourceDescriptionPacket.type:
      // not routed (SDES does not update the mapping)
      break;
    case RtcpTransportLayerFeedback.type:
      {
        const rtpfb = packet as RtcpTransportLayerFeedback;
        if (rtpfb.feedback?.count === TransportWideCC.count) {
          recipients.push(...twccFeedbackRecipients(rtpfb, transport, ctx));
        } else if (rtpfb.feedback) {
          recipients.push(
            ctx.endpointBySsrc(rtpfb.feedback.mediaSourceSsrc, transport),
          );
        }
      }
      break;
    case RtcpPayloadSpecificFeedback.type:
      {
        const psfb = packet as RtcpPayloadSpecificFeedback;
        // unknown FMT (SLI, RPSI, ...) is not parsed and is not routed
        if (!psfb.feedback) break;
        switch (psfb.feedback.count) {
          case ReceiverEstimatedMaxBitrate.count:
            {
              const remb = psfb.feedback as ReceiverEstimatedMaxBitrate;
              recipients.push(
                ctx.endpointBySsrc(remb.ssrcFeedbacks[0], transport),
              );
            }
            break;
          case PictureLossIndication.count:
            // RFC 4585 6.1: the target is the media source, never the sender of the feedback
            {
              const target = keyFrameRequestTarget(
                psfb.feedback.mediaSsrc,
                transport,
                ctx,
              );
              if (target) recipients.push(target);
            }
            break;
          case FullIntraRequest.count:
            {
              // RFC 5104 4.3.1: the media source SSRC SHALL be 0; the targets are the FCI entries
              const fir = psfb.feedback as FullIntraRequest;
              if (fir.fir.length === 0) {
                if (fir.mediaSsrc) {
                  recipients.push(ctx.endpointBySsrc(fir.mediaSsrc, transport));
                }
                break;
              }
              const targets = new Map<Endpoint, FirEntry[]>();
              for (const entry of fir.fir) {
                const target = keyFrameRequestTarget(
                  entry.ssrc,
                  transport,
                  ctx,
                );
                if (target) {
                  targets.set(target, [...(targets.get(target) ?? []), entry]);
                }
              }
              // each target once, a sender with the entries resolved to it
              targets.forEach((entries, target) => {
                if (target instanceof RTCRtpReceiver) {
                  target.handleRtcpPacket(packet);
                } else {
                  target.handleRtcpPacket(packet, entries);
                }
              });
            }
            break;
          default:
            recipients.push(
              ctx.endpointBySsrc(psfb.feedback.mediaSsrc, transport),
            );
        }
      }
      break;
  }
  recipients
    .filter((v): v is Endpoint => !!v) // todo simulcast
    .forEach((recipient) => recipient.handleRtcpPacket(packet));
}

/**
 * TWCC `media_ssrc` is the latest RTP SSRC, not the owner of the TSN range.
 * Fan-out the whole feedback to every sender on the same DTLS transport;
 * each estimator ignores sequences it did not send.
 *
 * When the incoming transport is known, only senders currently on it are
 * recipients: TSNs belong to that transport's sequence space, so a late
 * feedback for a sender that has moved elsewhere must not reach it (no
 * SSRC fallback to another transport).
 */
function twccFeedbackRecipients(
  rtpfb: RtcpTransportLayerFeedback,
  incomingTransport: RTCDtlsTransport | undefined,
  ctx: RtcpRoutingContext,
): Endpoint[] {
  if (incomingTransport) {
    return sendersOnTransport(ctx, incomingTransport);
  }
  const seed = ctx.endpointBySsrc(rtpfb.feedback.mediaSourceSsrc);
  const transport =
    seed && "dtlsTransport" in seed ? seed.dtlsTransport : undefined;
  const senders = sendersOnTransport(ctx, transport);
  if (senders.length > 0) {
    return senders;
  }
  return seed ? [seed] : [];
}

function sendersOnTransport(
  ctx: RtcpRoutingContext,
  transport?: RTCDtlsTransport,
): RTCRtpSender[] {
  const seen = new Set<RTCRtpSender>();
  const out: RTCRtpSender[] = [];
  for (const endpoint of ctx.endpoints()) {
    if (endpoint.type !== "sender") continue;
    const sender = endpoint as RTCRtpSender;
    if (transport && sender.dtlsTransport !== transport) {
      continue;
    }
    if (seen.has(sender)) {
      continue;
    }
    seen.add(sender);
    out.push(sender);
  }
  return out;
}

/** Endpoint a keyframe request for `ssrc` reaches; see {@link KeyFrameRequestRouting}. */
function keyFrameRequestTarget(
  ssrc: number,
  transport: RTCDtlsTransport | undefined,
  ctx: RtcpRoutingContext,
): Endpoint | undefined {
  const route = ctx.endpointBySsrc(ssrc, transport);
  if (route || ctx.keyFrameRequestRouting === "standard") return route;

  const senders = new Set(
    ctx.endpoints().filter(
      (endpoint): endpoint is RTCRtpSender =>
        !(endpoint instanceof RTCRtpReceiver) &&
        !endpoint.stopped &&
        // A request of another RTP session never reaches this sender.
        sameSession(endpoint, transport),
    ),
  );
  // RFC 4585 / RFC 4588 では、キーフレーム要求(PLI/FIR)の宛先は再送用(RTX)ではなく
  // 元のメディアストリームの SSRC であることが前提で、libwebrtc もメディア SSRC 宛に送る。
  // そのため strict では RTX SSRC を解決しない。ここは RTX SSRC 宛に送ってくる
  // 非準拠な相手向けの compatible 限定の救済措置。
  const rtxOwner = [...senders].find((sender) => sender.rtxSsrc === ssrc);
  if (rtxOwner) return rtxOwner;
  const videoSenders = [...senders].filter((sender) => sender.kind === "video");
  return videoSenders.length === 1 ? videoSenders[0] : undefined;
}
