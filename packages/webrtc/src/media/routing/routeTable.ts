import type { RTCDtlsTransport } from "../../transport/dtls";
import type { RTCRtpReceiver } from "../rtpReceiver";
import type { RTCRtpSender } from "../rtpSender";

/**
 * Where a route of an SSRC comes from, which also ranks it within one RTP
 * session: a local sender's own SSRC over a description's over one packets
 * taught.
 * @enum
 */
export const RouteOrigin = {
  sender: "sender",
  sdp: "sdp",
  learned: "learned",
} as const;
export type RouteOrigin = (typeof RouteOrigin)[keyof typeof RouteOrigin];

/** Rank of a route within one RTP session (higher wins). */
export const ORIGIN_RANK: Record<RouteOrigin, number> = {
  sender: 3,
  sdp: 2,
  learned: 1,
};

export type Endpoint = RTCRtpReceiver | RTCRtpSender;
export type Route = { endpoint: Endpoint; origin: RouteOrigin };
/** A route with its SSRC (`SsrcRouteTable.entries`). */
export type RouteEntry = { ssrc: number } & Route;

/** The transport a route belongs to (a sender without one: every transport). */
export const transportOf = (endpoint: Endpoint) =>
  endpoint.dtlsTransport as RTCDtlsTransport | undefined;

/**
 * `endpoint`'s route and one on `transport` are in one RTP session. An
 * endpoint without a transport, or a lookup without one, matches every
 * session.
 */
export const sameSession = (
  endpoint: Endpoint,
  transport: RTCDtlsTransport | undefined,
) => {
  const own = transportOf(endpoint);
  return !own || !transport || own === transport;
};

/**
 * SSRC → its routes. An SSRC is unique per RTP session only, so one SSRC may
 * have a route on each transport: a route belongs to its endpoint's current
 * `dtlsTransport` (a sender without one yet to every transport). The table
 * only stores routes; which one a packet reaches and what an added route
 * replaces are the rules of `RtpRouter`.
 */
export class SsrcRouteTable {
  private routes = new Map<number, Route[]>();

  constructor(entries: readonly (readonly [number, Route[]])[] = []) {
    for (const [ssrc, list] of entries) {
      for (const route of list) this.add(ssrc, { ...route });
    }
  }

  /** The routes of `ssrc` (a copy-free view; do not mutate). */
  of(ssrc: number): readonly Route[] {
    return this.routes.get(ssrc) ?? [];
  }

  add(ssrc: number, route: Route) {
    const list = this.routes.get(ssrc);
    if (list) list.push(route);
    else this.routes.set(ssrc, [route]);
  }

  /** Drop the routes of `ssrc` that `drop` selects. */
  remove(ssrc: number, drop: (route: Route) => boolean) {
    const list = this.routes.get(ssrc);
    if (!list) return;
    const kept = list.filter((route) => !drop(route));
    if (kept.length) this.routes.set(ssrc, kept);
    else this.routes.delete(ssrc);
  }

  /** Drop every route of `endpoints`, whatever its SSRC. */
  removeEndpoints(endpoints: readonly Endpoint[]) {
    for (const ssrc of [...this.routes.keys()]) {
      this.remove(ssrc, (r) => endpoints.includes(r.endpoint));
    }
  }

  ssrcs() {
    return [...this.routes.keys()];
  }

  /** Every route with its SSRC. */
  entries(): RouteEntry[] {
    return [...this.routes].flatMap(([ssrc, list]) =>
      list.map((route) => ({ ssrc, ...route })),
    );
  }

  /** A copy of every route, per SSRC (a negotiation baseline). */
  snapshot() {
    return [...this.routes].map(
      ([ssrc, list]) => [ssrc, list.map((r) => ({ ...r }))] as const,
    );
  }
}
