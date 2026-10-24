/**
 * Negotiation state shapes and helpers shared between the media components
 * and the negotiation transaction. Internal: not re-exported by the package.
 */
import type { RtpRouter } from "../media/router";
import type { RTCRtpReceiver } from "../media/rtpReceiver";
import type { RTCRtpTransceiver } from "../media/rtpTransceiver";
import type { MediaStreamTrack } from "../media/track";

/** A transceiver's negotiation state, for a rollback baseline. */
export type TransceiverNegotiationState = ReturnType<
  RTCRtpTransceiver["snapshotNegotiationState"]
>;

/** A receiver's negotiation state, for a rollback baseline. */
export type ReceiverNegotiationState = ReturnType<
  RTCRtpReceiver["snapshotNegotiationState"]
>;

/** The routes of a router, for a negotiation rollback baseline. */
export type RouterSnapshot = ReturnType<RtpRouter["snapshotRoutes"]>;

/** The transceivers of a PeerConnection and their negotiation state. */
export type TransceiversNegotiationState = {
  order: RTCRtpTransceiver[];
  states: Map<
    RTCRtpTransceiver,
    {
      transceiver: TransceiverNegotiationState;
      notifiedRemoteTrack?: { track: MediaStreamTrack; streams: string[] };
    }
  >;
};

/**
 * RIDs are scoped to their m-line (RFC 8851), so simulcast routes are keyed
 * by MID and RID: two m-lines may reuse the same RID names.
 */
export const ridRouteKey = (mid: string, rid: string) => `${mid}\u0000${rid}`;

const applicationStops = new WeakMap<RTCRtpTransceiver, number>();

/** How many times the application called `stop()` on `transceiver`. */
export function getApplicationStopRevision(transceiver: RTCRtpTransceiver) {
  return applicationStops.get(transceiver) ?? 0;
}

/** Record an application `stop()`; a rollback keeps it. */
export function noteApplicationStop(transceiver: RTCRtpTransceiver) {
  applicationStops.set(
    transceiver,
    getApplicationStopRevision(transceiver) + 1,
  );
}
