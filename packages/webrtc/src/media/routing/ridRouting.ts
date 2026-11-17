import { debug } from "../../imports/rtp";
import { ridRouteKey } from "../../negotiation/internalState";
import type { RTCDtlsTransport } from "../../transport/dtls";
import { RTCRtpReceiver } from "../rtpReceiver";
import type { RTCRtpSender } from "../rtpSender";
import type { RTCRtpTransceiver } from "../rtpTransceiver";
import { type Endpoint, sameSession } from "./routeTable";

const log = debug("werift:packages/webrtc/src/media/routing/ridRouting.ts");

/** MID + RID → receiver (keys of {@link ridRouteKey}). */
export type RidTable = { [midAndRid: string]: RTCRtpReceiver | RTCRtpSender };

/** What the RID lookups read: the RID routes and the transceivers. */
export type RidLookup = {
  ridTable: RidTable;
  transceivers: () => readonly RTCRtpTransceiver[];
};

/** The RID of a {@link ridRouteKey}. */
export const ridOfRouteKey = (key: string) =>
  key.slice(key.indexOf("\u0000") + 1);

/**
 * The receiver of an RTP stream ID in the RTP session of `transport`: by
 * MID and RID when the packet carries a MID extension that names a route,
 * otherwise (no MID extension, or a MID value no route uses) the first
 * m-line of that session that uses the RID. A MID naming an m-line of
 * another transport names nothing here (dropped). Without a transport every
 * session counts, as develop does.
 */
export function receiverByRid(
  { ridTable, transceivers }: RidLookup,
  rid: string,
  mid: unknown,
  transport?: RTCDtlsTransport,
): RTCRtpReceiver | undefined {
  const inSession = (endpoint: Endpoint | undefined) =>
    !!endpoint && sameSession(endpoint, transport);
  if (typeof mid === "string") {
    // A MID naming an m-line of another RTP session names no stream here.
    const named = transceivers().find((t) => t.mid === mid);
    if (named && !inSession(named.receiver)) {
      log("rid receiver on another transport", { rid, mid });
      return undefined;
    }
    const byMid = ridTable[ridRouteKey(mid, rid)];
    if (byMid && inSession(byMid)) return byMid as RTCRtpReceiver;
  }
  const key = Object.keys(ridTable).find(
    (candidate) =>
      ridOfRouteKey(candidate) === rid && inSession(ridTable[candidate]),
  );
  return key ? (ridTable[key] as RTCRtpReceiver) : undefined;
}

/**
 * Whether a RID a packet carries belongs to an m-line without SSRC and RID
 * that waits for it (a pending description's RID, see `deferredRemote`),
 * so it must not be looked up on another m-line that uses the same RID:
 * - the m-line the packet names (its MID, else its SSRC's route) is
 *   SSRC-less and has no route for the RID: `"pending"`;
 * - for a packet naming none, the payload type decides on its transport
 *   (RFC 9143 section 9.2): only such a waiting m-line receives it —
 *   `"pending"`; a committed m-line with the RID receives it too —
 *   `"ambiguous"` (dropped); only committed ones — `"none"`, so a committed
 *   stream switching its SSRC keeps its route.
 */
export function pendingRidOwner(
  { ridTable, transceivers }: RidLookup,
  rid: string,
  mid: unknown,
  route: RTCRtpReceiver | undefined,
  transport: RTCDtlsTransport | undefined,
  payloadType: number,
): "pending" | "ambiguous" | "none" {
  const owner =
    typeof mid === "string"
      ? transceivers().find((t) => t.mid === mid)
      : transceivers().find((t) => !!route && t.receiver === route);
  if (owner) {
    return owner.receiver.acceptsUnknownSsrc &&
      !ridTable[ridRouteKey(owner.mid ?? "", rid)]
      ? "pending"
      : "none";
  }
  const receives = (receiver: RTCRtpReceiver) =>
    receiver.receivesMediaPayloadType(payloadType) ||
    receiver.receivesRtxPayloadType(payloadType);
  const onTransport = (receiver: RTCRtpReceiver) =>
    !transport || receiver.dtlsTransport === transport;
  const waiting = transceivers().some(
    (t) =>
      onTransport(t.receiver) &&
      !!t.receiver.deferredRemote?.simulcast.some((p) => p.rid === rid) &&
      receives(t.receiver),
  );
  if (!waiting) return "none";
  const committed = Object.entries(ridTable).some(
    ([key, endpoint]) =>
      ridOfRouteKey(key) === rid &&
      endpoint instanceof RTCRtpReceiver &&
      onTransport(endpoint) &&
      receives(endpoint),
  );
  return committed ? "ambiguous" : "pending";
}
