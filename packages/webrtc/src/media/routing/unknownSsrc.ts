import type { RTCDtlsTransport } from "../../transport/dtls";
import type { RTCRtpReceiver } from "../rtpReceiver";
import type { RTCRtpTransceiver } from "../rtpTransceiver";

/**
 * Why a packet with an SSRC no route knows was not learned (debug log).
 * @enum
 */
export const UnknownSsrcDrop = {
  noTransport: "no transport",
  rtx: "rtx",
  midMismatch: "mid mismatch",
  transportMismatch: "transport mismatch",
  notReceiving: "not receiving",
  hasSsrc: "m-line has ssrc or rid",
  unknownPayloadType: "unknown payload type",
  malformedPayload: "malformed payload",
  noCandidate: "no candidate",
  ambiguous: "ambiguous",
} as const;
export type UnknownSsrcDrop =
  (typeof UnknownSsrcDrop)[keyof typeof UnknownSsrcDrop];

/** The receiver that may learn an unknown SSRC, or why none may. */
export type UnknownSsrcCandidate =
  | { receiver: RTCRtpReceiver }
  | { drop: UnknownSsrcDrop; detail?: object };

/**
 * RFC 9143 section 9.2: the receiver that may learn an SSRC no route, RID or
 * simulcast track knows. Without the transport the packet arrived on there
 * is none.
 * - A MID extension names the only candidate: the transceiver of that MID.
 * - Otherwise the payload type names the m-line: exactly one receiving
 *   m-line on that transport may receive it (as media or RTX, whether or
 *   not it has `a=ssrc` or RIDs), and that one must be a candidate. A
 *   payload type two m-lines receive names neither.
 *
 * A candidate is on the packet's transport; is a receiving transceiver
 * (`recvonly` / `sendrecv`, not stopped, stopping or pending rejection)
 * whose remote m-line sends (`ontrack` was fired); has neither an SDP SSRC
 * nor a RID (`acceptsUnknownSsrc`), so an SSRC change or a stray SSRC of an
 * m-line with `a=ssrc` is never taken for it; and receives the payload
 * type as a media codec. RTX (an RTX payload type, or a
 * `repaired-rtp-stream-id`) teaches nothing: without `ssrc-group:FID`
 * nothing pairs it with the media SSRC.
 * Receiving is decided by the committed `currentDirection`; a pending
 * description decides only before the first commit.
 *
 * Only decides: binding the SSRC and its route is `RtpRouter`'s.
 */
export function unknownSsrcCandidate(
  transceivers: readonly RTCRtpTransceiver[],
  {
    mid,
    payloadType,
    repaired,
    transport,
  }: {
    mid: unknown;
    payloadType: number;
    repaired: boolean;
    transport: RTCDtlsTransport | undefined;
  },
): UnknownSsrcCandidate {
  if (!transport) return { drop: UnknownSsrcDrop.noTransport };
  if (repaired) return { drop: UnknownSsrcDrop.rtx };

  if (typeof mid === "string") {
    const transceiver = transceivers.find((t) => t.mid === mid);
    if (!transceiver) {
      return { drop: UnknownSsrcDrop.midMismatch, detail: { mid } };
    }
    const { receiver } = transceiver;
    if (receiver.dtlsTransport !== transport) {
      return { drop: UnknownSsrcDrop.transportMismatch, detail: { mid } };
    }
    if (!receiving(transceiver)) {
      return { drop: UnknownSsrcDrop.notReceiving, detail: { mid } };
    }
    if (!receiver.acceptsUnknownSsrc) {
      return { drop: UnknownSsrcDrop.hasSsrc, detail: { mid } };
    }
    if (!receiver.receivesMediaPayloadType(payloadType)) {
      return {
        drop: receiver.receivesRtxPayloadType(payloadType)
          ? UnknownSsrcDrop.rtx
          : UnknownSsrcDrop.unknownPayloadType,
        detail: { mid },
      };
    }
    return { receiver };
  }

  // A payload type names an m-line only when no other m-line of the RTP
  // session receives it (RFC 9143 section 9.2): every receiving m-line on
  // the transport counts, with or without `a=ssrc` or RIDs, and as media or
  // RTX. Only then may the one m-line be a candidate.
  const onTransport = transceivers.filter(
    (t) => t.receiver.dtlsTransport === transport && receiving(t),
  );
  const byPayloadType = onTransport.filter(
    (t) =>
      t.receiver.receivesMediaPayloadType(payloadType) ||
      t.receiver.receivesRtxPayloadType(payloadType),
  );
  const mids = byPayloadType.map((t) => t.mid);
  if (byPayloadType.length === 0) {
    return {
      drop: onTransport.some((t) => t.receiver.acceptsUnknownSsrc)
        ? UnknownSsrcDrop.unknownPayloadType
        : UnknownSsrcDrop.noCandidate,
    };
  }
  if (byPayloadType.length > 1) {
    return { drop: UnknownSsrcDrop.ambiguous, detail: { mids } };
  }
  const { receiver } = byPayloadType[0];
  if (receiver.receivesRtxPayloadType(payloadType)) {
    return { drop: UnknownSsrcDrop.rtx, detail: { mids } };
  }
  if (!receiver.acceptsUnknownSsrc) {
    return { drop: UnknownSsrcDrop.hasSsrc, detail: { mids } };
  }
  return { receiver };
}

/**
 * The committed session decides: `currentDirection` is the negotiated
 * direction, so a pending offer that changes `direction`, the remote
 * direction (`firedReceiving`) or marks a rejection leaves a running stream
 * receiving until the transaction commits. Only before the first commit (no
 * `currentDirection`) the provisional description decides.
 */
function receiving(t: RTCRtpTransceiver) {
  if (t.stopped || t.stopping) return false;
  const current = t.currentDirection;
  if (current) return current === "recvonly" || current === "sendrecv";
  return (
    ["recvonly", "sendrecv"].includes(t.direction) &&
    t.firedReceiving &&
    !t.pendingRejection
  );
}
