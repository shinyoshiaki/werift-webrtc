import {
  debug,
  type Extensions,
  RTP_EXTENSION_URI,
  type RtcpPacket,
  type RtpPacket,
  rtpHeaderExtensionsParser,
} from "../imports/rtp";
import { type RouterSnapshot, ridRouteKey } from "../negotiation/internalState";
import type { RTCDtlsTransport } from "../transport/dtls";
import { deliveredTrackCodec, primaryTrackCodec } from "./codecCompatibility";
import type {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { PendingSsrcRoutes, type StagedRoutes } from "./routing/pendingRoutes";
import { pendingRidOwner, receiverByRid } from "./routing/ridRouting";
import {
  type Endpoint,
  ORIGIN_RANK,
  type Route,
  RouteOrigin,
  SsrcRouteTable,
  sameSession,
  transportOf,
} from "./routing/routeTable";
import {
  type KeyFrameRequestRouting,
  routeRtcp as routeRtcpPacket,
} from "./routing/rtcpRouting";
import {
  type UnknownSsrcDrop,
  unknownSsrcCandidate,
} from "./routing/unknownSsrc";
import { type FallbackStream, RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import type { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./track";

export {
  type KeyFrameRequestRouting,
  KeyFrameRequestRoutingModes,
} from "./routing/rtcpRouting";

const log = debug("werift:packages/webrtc/src/media/router.ts");

/**
 * RTP routing tables shared by the current session and a pending proposal.
 * One rule covers every key: a pending remote offer or pranswer may **add**
 * keys, effective at once so provisional RTP flows, but a key the current
 * session uses keeps its value until the final answer. A conflicting value is
 * rejected before any mutation or staged until commit; rollback drops what was
 * staged and restores the baseline (`snapshotRoutes` / `restoreRoutes`).
 *
 * | Key | Table | Conflicting proposal |
 * | --- | --- | --- |
 * | Payload type → codec | receiver codec table | remap rejected (RFC 3264 section 8.3.2); fmtp / rtcp-fb change staged |
 * | Header extension ID → URI | `extIdUriMap` | remap of an ID in use rejected (RFC 8285 section 7); a URI on a new ID is an addition |
 * | SSRC → receiver | `routes` (origin `sdp`) | move to another m-line staged |
 * | RTX SSRC → media SSRC | receiver RTX table | changed pairing staged |
 * | MID+RID → receiver | `ridTable` | RIDs are scoped to their m-line (RFC 8851): no conflict |
 * | Sender SSRC → sender | `routes` (origin `sender`) | application state: rollback keeps every live sender's route |
 *
 * Packet-driven routes are not description state: an SSRC first seen with
 * `rtp-stream-id` / `repaired-rtp-stream-id` gets a route of origin
 * `learned`, and the receiver learns RID → media SSRC and RTX
 * SSRC → RID (`mediaSsrcByRid` / `ridByRtxSsrc`). Commit and rollback keep them.
 * They are bounded per RID: an SSRC the receiver retires (a media SSRC change
 * of the RID) or evicts loses its learned route here (`takeForgottenSsrcs`),
 * and unregistering a transceiver drops its learned SSRCs.
 *
 * | Packet-driven key | Learned when | Bound |
 * | --- | --- | --- |
 * | SSRC → receiver (RID) | `rtp-stream-id` / `repaired-rtp-stream-id` names a route | per RID (receiver) |
 * | SSRC → receiver (simulcast) | the SSRC is a learned track SSRC of a RID receiver on the packet's transport | as above |
 * | SSRC → receiver (fallback, RFC 9143 section 9.2) | see {@link learnUnknownSsrc} | 8 per receiver, oldest forgotten first |
 *
 * The fallback serves remote m-lines without `a=ssrc` and RIDs (SIP gateways,
 * SBCs, media servers): an SSRC no route, RID or simulcast track knows is
 * learned for the receiver the packet's MID names, or else for the receiver
 * of the only m-line on the packet's transport that receives the payload type
 * (one with `a=ssrc` or RIDs counts too, and then nothing is learned); when
 * that is ambiguous, or the packet comes without a
 * transport (`routeRtp(packet)`), it is dropped. A learned SSRC maps to the
 * default track `ontrack` announced (`RTCRtpReceiver.bindFallbackSsrc`). A
 * new SSRC (a SIP re-INVITE, a media server switch) is learned beside the
 * earlier ones, which keep mapping to the same track: a late packet of a
 * replaced stream is delivered there and resets nothing; `track.ssrc` is the
 * newest, and the oldest beyond 8 is forgotten. Like the other packet-driven
 * routes they are added at once while a description is pending, and commit
 * and rollback keep them while the m-line stays without SSRC and RID (a
 * rollback forgets those learned with a payload type only the rolled-back
 * description gave).
 *
 * A pending description does not touch an m-line whose current session is
 * without SSRC and RID: its SSRCs and RIDs wait in
 * `RTCRtpReceiver.deferredRemote` and register at the commit
 * (`commitStaged`), as an answer's would; rollback drops them with the rest
 * of the description. Until then the current session's track, statistics,
 * routes and learning stay as they are: a packet of the pending SSRC is
 * learned like any unknown SSRC, and one with a pending RID is the current
 * stream's. At the commit the learned SSRCs go (the description's SSRCs and
 * RIDs route from now on), except one that already carried a committed RID,
 * which becomes that RID's media SSRC. The first SSRC of the description
 * binds the announced track (`RTCRtpReceiver.adoptDefaultTrack`), so `ontrack`
 * does not fire again for it; a RID track replacing it is announced after
 * the commit. Unregistering the transceiver drops the learned SSRCs.
 *
 * A MID updates the mapping of a learned SSRC (RFC 9143 section 9.2) only
 * from a packet whose extended sequence number is newer than the one of the
 * last update: an older packet is delivered through the mapping it finds.
 * A newer MID naming another m-line moves the SSRC there when that m-line may
 * learn it, else the packet is dropped. Routes from SDP, RIDs and simulcast
 * keep their receiver whatever the MID (existing behaviour). A rollback keeps
 * the receiver packets taught last, even over a baseline route packets
 * taught another receiver.
 *
 * Every identifier of a packet — SSRC, RID (`rtp-stream-id`), RRID
 * (`repaired-rtp-stream-id`) and MID — resolves within the packet's RTP
 * session (its DTLS transport) only: a route, RID route or m-line of another
 * transport is never reached, and a MID naming one drops the packet.
 *
 * An SSRC is unique per RTP session only, so `routes` keeps, per SSRC, a
 * set of routes `{ endpoint, origin }`, each belonging to its endpoint's
 * current `dtlsTransport` (a transceiver moved to another transport takes
 * it along; a sender without a transport yet belongs to every one). A
 * packet, RTP or RTCP (SR, RR and every feedback naming an SSRC), resolves
 * to the highest ranked route of its transport ({@link endpointBySsrc}):
 *
 * | Origin | Added by | Rank in one RTP session | Other transports |
 * | --- | --- | --- | --- |
 * | `sender` | `registerRtpSender` | 1: a remote stream using it is a collision (RFC 3550 section 8.2): its RTP is dropped and nothing is learned, whatever RID, repaired RID or MID it carries | other streams, routed there |
 * | `sdp` | `registerRtpReceiver` (an answer, a commit, or a pending description without conflict) | 2: a learned owner forgets the SSRC; another receiver's description route of the SSRC goes (the later description wins) | other streams, routed there |
 * | `learned` | packets (RID, simulcast, fallback) | 3: never beside a `sender` / `sdp` route of another endpoint | other streams, routed there |
 *
 * A receiver that loses its learned SSRC — a fallback SSRC, a RID's media
 * SSRC or a RID's RTX SSRC — because a sender or description of its session
 * registers it, or a BUNDLE merge brings it into such a session, forgets it
 * (`RTCRtpReceiver.releaseLearnedSsrc`), so its track and statistics agree
 * with the table. A description route a pending description added in one
 * session is taken again in the session its receiver has at the commit.
 * Sender enumeration (TWCC fan-out, keyframe fallback) reads the same
 * routes, within the packet's session.
 *
 * A payload type or extension ID counts as in use only when both current
 * descriptions carry it for the m-line. RID lookup uses MID+RID when the
 * packet's MID names a route, else the RID alone. `extIdUriMap` is shared by
 * the whole PeerConnection: m-lines on separate transports that map one ID to
 * different URIs are not supported. A current remote SSRC that a later answer
 * omits stays routed; only SSRCs a replaced pranswer alone added are dropped.
 */
export class RtpRouter {
  /**
   * SSRC → its routes. An SSRC is unique per RTP session only, so one SSRC
   * may have a route on each transport: a route belongs to its endpoint's
   * current `dtlsTransport` (a sender without one yet to every transport),
   * and a packet resolves to the highest ranked route of its transport
   * ({@link endpointBySsrc}, `RouteOrigin`).
   */
  private routes = new SsrcRouteTable();
  /** Keyed by {@link ridRouteKey} (MID + RID). */
  ridTable: { [midAndRid: string]: RTCRtpReceiver | RTCRtpSender } = {};
  /**
   * Routes a pending offer or pranswer would move away from the receiver the
   * current session uses. They apply at commit; until then current RTP keeps
   * its route, and rollback drops them. Keyed by SSRC and RTP session: one
   * entry per SSRC per transport (`PendingSsrcRoutes`).
   */
  private stagedSsrc = new PendingSsrcRoutes();
  private stagedRid = new Map<string, RTCRtpReceiver>();
  /**
   * New SSRC routes a pending description added at once (no conflict). A
   * later remote pranswer / answer replaces them, the commit keeps them.
   * Keyed like `stagedSsrc`.
   */
  private provisionalSsrc = new PendingSsrcRoutes();
  extIdUriMap: { [id: number]: string } = {};

  keyFrameRequestRouting: KeyFrameRequestRouting = "fallback";
  /**
   * Internal: the transceivers of the PeerConnection, for the fallback of
   * {@link learnUnknownSsrc}. Set by the TransceiverManager; the router keeps
   * no table of its own for it, so negotiation snapshots stay as they are.
   */
  transceivers: () => readonly RTCRtpTransceiver[] = () => [];
  /**
   * Internal: the track `ontrack` last announced for a transceiver (set by
   * the TransceiverManager). A replacement offer resets `firedReceiving`
   * before it applies, while the announcement of the default track stands.
   */
  announcedTrack: (
    transceiver: RTCRtpTransceiver,
  ) => MediaStreamTrack | undefined = () => undefined;
  /** Last logged drop of an unknown SSRC, so a stream logs a reason once. */
  private lastUnknownSsrcDrop?: string;

  constructor() {}

  /**
   * Test / observation view: SSRC → the endpoint a packet without a
   * transport reaches (the highest ranked route, the first of a rank).
   */
  get ssrcTable(): { [ssrc: number]: Endpoint } {
    const table: { [ssrc: number]: Endpoint } = {};
    for (const ssrc of this.routes.ssrcs()) {
      const endpoint = this.endpointBySsrc(ssrc);
      if (endpoint) table[ssrc] = endpoint;
    }
    return table;
  }

  /** Test / observation view: SSRCs that have a route packets taught. */
  get learnedSsrcs(): ReadonlySet<number> {
    const ssrcs = new Set<number>();
    for (const { ssrc, origin } of this.routes.entries()) {
      if (origin === RouteOrigin.learned) ssrcs.add(ssrc);
    }
    return ssrcs;
  }

  /**
   * Test / observation view: learned receiver routes beside the route a
   * packet without a transport reaches (the same SSRC on another transport).
   */
  private get collidingRoutes(): Map<number, Set<RTCRtpReceiver>> {
    const out = new Map<number, Set<RTCRtpReceiver>>();
    for (const ssrc of this.routes.ssrcs()) {
      const top = this.endpointBySsrc(ssrc);
      for (const route of this.routes.of(ssrc)) {
        if (route.origin !== RouteOrigin.learned || route.endpoint === top) {
          continue;
        }
        let set = out.get(ssrc);
        if (!set) out.set(ssrc, (set = new Set()));
        set.add(route.endpoint as RTCRtpReceiver);
      }
    }
    return out;
  }

  /** Test / observation view: every route with its SSRC. */
  get routeEntries(): {
    ssrc: number;
    endpoint: Endpoint;
    origin: RouteOrigin;
  }[] {
    return this.routes.entries();
  }

  /**
   * A local sender's own SSRC. In its RTP session it outranks a receiver
   * route: a learned SSRC there is a remote collision (RFC 3550 section 8.2)
   * and is forgotten; an SDP route there stays but receives nothing. Routes
   * of other transports are other streams and stay.
   */
  registerRtpSender(sender: RTCRtpSender) {
    const ssrc = sender.ssrc;
    if (this.routes.of(ssrc).some((r) => r.endpoint === sender)) return;
    for (const owner of this.learnedOwnersIn(ssrc, sender)) {
      this.releaseLearnedSsrc(owner, ssrc);
    }
    this.routes.add(ssrc, { endpoint: sender, origin: RouteOrigin.sender });
  }

  /** Internal: the negotiation committed, staged routes replace current ones. */
  commitStaged() {
    for (const [ssrc, receiver] of this.stagedSsrc) {
      this.takeSsrcRoute(ssrc, receiver);
    }
    // A route the pending description added at once was taken in the RTP
    // session of that time; the commit may have moved its receiver into
    // another one (a BUNDLE merge), where it replaces the description routes
    // and learned owners as a registration there would.
    for (const [ssrc, receiver] of this.provisionalSsrc) {
      if (
        this.routes
          .of(ssrc)
          .some((r) => r.endpoint === receiver && r.origin === RouteOrigin.sdp)
      ) {
        this.takeSsrcRoute(ssrc, receiver);
      }
    }
    for (const [key, receiver] of this.stagedRid) {
      this.ridTable[key] = receiver;
    }
    this.stagedSsrc.clear();
    this.stagedRid.clear();
    this.provisionalSsrc.clear();
    // An m-line whose current session was without SSRC and RID gets what the
    // committed description gave it only now (`deferredRemote`).
    for (const transceiver of this.transceivers()) {
      this.applyDeferredRemote(transceiver);
    }
    // A fallback SSRC of an m-line the committed description gave an SSRC or
    // a RID goes now.
    for (const { receiver } of this.transceivers()) {
      if (!receiver.acceptsUnknownSsrc) this.releaseFallbackSsrcs(receiver);
    }
  }

  /**
   * The commit of a description `deferRemote` kept from an m-line without
   * SSRC and RID: its RIDs and SSRCs register as an answer's would. A
   * fallback SSRC that already carried one of its RIDs is that RID's media
   * SSRC from now on and keeps its learned route.
   */
  private applyDeferredRemote(transceiver: RTCRtpTransceiver) {
    const { receiver } = transceiver;
    const deferred = receiver.deferredRemote;
    if (!deferred) return;
    receiver.deferredRemote = undefined;
    // A transceiver the application stopped meanwhile takes nothing.
    if (transceiver.stopped || transceiver.stopping || receiver.stopped) return;
    for (const param of deferred.simulcast) {
      this.registerRtpReceiverByRid(transceiver, param, deferred.params);
    }
    this.registerRtpReceiverBySsrc(transceiver, deferred.params);
  }

  /** A learned fallback SSRC that carried `rid` becomes that RID's media SSRC. */
  private adoptCarriedRid(receiver: RTCRtpReceiver, rid: string) {
    const ssrc = receiver.fallbackSsrcsByRid().get(rid);
    if (ssrc === undefined) return;
    this.releaseFallbackSsrc(receiver, ssrc);
    if (
      !this.endpointBySsrc(ssrc, receiver.dtlsTransport) &&
      receiver.adoptFallbackSsrcForRid(rid, ssrc)
    ) {
      this.learnSsrc(ssrc, receiver);
    }
  }

  /**
   * A pending description (`deferConflicts`) does not touch an m-line whose
   * current session announced the default track and is without SSRC and RID:
   * its SSRCs and RIDs wait in `RTCRtpReceiver.deferredRemote` for the
   * commit, so until then the track, its statistics, the routes and the
   * learning of unknown SSRCs stay the current session's (a new SSRC of the
   * pending description is learned like any other unknown SSRC).
   */
  private defersRemote(
    transceiver: RTCRtpTransceiver,
    deferConflicts: boolean,
  ) {
    const { receiver } = transceiver;
    // A replacement offer resets `firedReceiving`; a session receiving on
    // the default track (learned fallback SSRCs) still counts. A pranswer's
    // provisional `currentDirection` does not tell a committed session.
    const announced =
      transceiver.firedReceiving || receiver.fallbackSsrcs.length > 0;
    return (
      deferConflicts &&
      (receiver.deferredRemote !== undefined ||
        (announced && receiver.tracks.length === 0))
    );
  }

  /** Internal: drop the routes an earlier pending description added at once. */
  discardProvisional() {
    for (const [ssrc, receiver] of this.provisionalSsrc) {
      const route = this.routes
        .of(ssrc)
        .find((r) => r.endpoint === receiver && r.origin === RouteOrigin.sdp);
      if (route) {
        this.routes.remove(ssrc, (r) => r === route);
        receiver.releaseProvisionalSsrc(ssrc);
      }
    }
    this.provisionalSsrc.clear();
  }

  /** Internal: capture staged routes for a transaction baseline or checkpoint. */
  snapshotStaged(): StagedRoutes {
    return {
      ssrc: this.stagedSsrc.entries(),
      rid: [...this.stagedRid],
      provisional: this.provisionalSsrc.entries(),
    };
  }

  /** Internal: restore staged routes (an empty snapshot discards them). */
  restoreStaged(snapshot: StagedRoutes) {
    this.stagedSsrc = new PendingSsrcRoutes(snapshot.ssrc);
    this.stagedRid = new Map(snapshot.rid);
    this.provisionalSsrc = new PendingSsrcRoutes(snapshot.provisional);
  }

  /** Internal: every route a negotiation may change, for a rollback baseline. */
  snapshotRoutes() {
    return {
      /** Every route (description, sender and packet-driven ones). */
      routes: this.routes.snapshot(),
      ridTable: { ...this.ridTable },
      extIdUriMap: { ...this.extIdUriMap },
      staged: this.snapshotStaged(),
    };
  }

  /**
   * Internal: return to a negotiation baseline. Two kinds of route are not
   * description state and survive: SSRCs learned from packets for an endpoint
   * still attached, and the own SSRC of every live sender (including one the
   * application added while the description was pending). Likewise a route
   * packets taught before the baseline and later dropped (an SSRC retired by
   * a media SSRC change of its RID, or evicted) stays dropped: the baseline
   * does not bring packet-driven routes back.
   */
  restoreRoutes(
    snapshot: RouterSnapshot,
    {
      endpoints,
      liveSenders,
    }: {
      endpoints: Set<RTCRtpReceiver | RTCRtpSender>;
      liveSenders: RTCRtpSender[];
    },
  ) {
    // Description routes return to the baseline. Routes packets taught are
    // not description state: the current ones of attached endpoints stay
    // (also over a baseline one packets taught another receiver), and one
    // the baseline had that was dropped since stays dropped. Every live
    // sender keeps its route (also one added while the description was
    // pending).
    const learned = this.routeEntries.filter(
      (r) => r.origin === RouteOrigin.learned && endpoints.has(r.endpoint),
    );
    this.routes = new SsrcRouteTable();
    for (const [ssrc, list] of snapshot.routes) {
      for (const route of list) {
        if (route.origin !== RouteOrigin.learned)
          this.routes.add(ssrc, { ...route });
      }
    }
    for (const { ssrc, endpoint, origin } of learned) {
      this.routes.add(ssrc, { endpoint, origin });
    }
    for (const sender of liveSenders) this.registerRtpSender(sender);
    this.ridTable = { ...snapshot.ridTable };
    this.extIdUriMap = { ...snapshot.extIdUriMap };
    this.restoreStaged(snapshot.staged);
    // Receivers restore first (`NegotiationTransaction`): an SSRC a receiver
    // forgot there (learned for a track the rollback removed) loses its
    // learned route too, so receiver and router agree.
    for (const endpoint of endpoints) {
      if (!(endpoint instanceof RTCRtpReceiver)) continue;
      for (const ssrc of endpoint.takeForgottenSsrcs()) {
        this.unlearnSsrc(ssrc, endpoint);
      }
    }
  }

  /** Test-only observation of staged routes. */
  get staged() {
    return this.snapshotStaged();
  }

  unregisterTransceiver(transceiver: RTCRtpTransceiver) {
    transceiver.receiver.deferredRemote = undefined;
    transceiver.receiver.releaseFallbackSsrcs();
    transceiver.receiver.takeForgottenSsrcs();
    this.stagedSsrc.deleteReceiver(transceiver.receiver);
    this.provisionalSsrc.deleteReceiver(transceiver.receiver);
    for (const [key, receiver] of this.stagedRid) {
      if (receiver === transceiver.receiver) this.stagedRid.delete(key);
    }
    this.routes.removeEndpoints([transceiver.sender, transceiver.receiver]);
    for (const [rid, endpoint] of Object.entries(this.ridTable)) {
      if (
        endpoint === transceiver.sender ||
        endpoint === transceiver.receiver
      ) {
        delete this.ridTable[rid];
      }
    }
  }

  private registerRtpReceiver(
    receiver: RTCRtpReceiver,
    ssrc: number,
    deferConflicts = false,
  ) {
    log("registerRtpReceiver", ssrc);
    const own = this.routes.of(ssrc).some((r) => r.endpoint === receiver);
    // A route of the current session the registration would take away keeps
    // the SSRC until the commit: another receiver's description route or a
    // learned owner in this RTP session. Senders and other sessions' routes
    // stay beside it.
    const conflicts =
      this.routes
        .of(ssrc)
        .some(
          (r) =>
            r.origin === RouteOrigin.sdp &&
            r.endpoint !== receiver &&
            sameSession(r.endpoint, receiver.dtlsTransport),
        ) || this.learnedOwnersIn(ssrc, receiver).length > 0;
    if (deferConflicts && conflicts) {
      this.stagedSsrc.set(ssrc, receiver);
      return;
    }
    if (deferConflicts && !own) this.provisionalSsrc.set(ssrc, receiver);
    if (!deferConflicts) this.provisionalSsrc.delete(ssrc, receiver);
    this.stagedSsrc.delete(ssrc, receiver);
    this.takeSsrcRoute(ssrc, receiver);
  }

  /**
   * With `deferConflicts` (a pending offer or pranswer) an SSRC the current
   * session routes to another receiver is staged until commit; new SSRCs route
   * at once so provisional RTP flows.
   */
  registerRtpReceiverBySsrc(
    transceiver: RTCRtpTransceiver,
    params: RTCRtpReceiveParameters,
    { deferConflicts = false }: { deferConflicts?: boolean } = {},
  ) {
    log("registerRtpReceiverBySsrc", params);

    const hasSsrcs =
      params.encodings.some((e) => e.ssrc != undefined) ||
      (params.ridRtxPairs?.length ?? 0) > 0;
    if (
      this.defersRemote(transceiver, deferConflicts) &&
      (hasSsrcs || transceiver.receiver.deferredRemote)
    ) {
      const deferred = (transceiver.receiver.deferredRemote ??= {
        params,
        simulcast: [],
      });
      deferred.params = params;
      this.registerHeaderExtensions(params);
      return;
    }
    if (hasSsrcs && !deferConflicts) {
      // The m-line has SSRCs now: the SSRCs learned without them go.
      this.releaseFallbackSsrcs(transceiver.receiver);
    }

    params.encodings
      .filter((e) => e.ssrc != undefined) // todo fix
      .forEach((encode, i) => {
        this.registerRtpReceiver(
          transceiver.receiver,
          encode.ssrc,
          deferConflicts,
        );
        const codec = deliveredTrackCodec(
          transceiver.kind,
          params.codecs[i],
          params.codecs,
        );
        // An m-line that was without SSRC and RID keeps the track `ontrack`
        // announced: the first SSRC a description gives it binds that track.
        const announced =
          i === 0 &&
          transceiver.receiver.tracks.length === 0 &&
          (transceiver.firedReceiving ||
            this.announcedTrack(transceiver) === transceiver.receiver.track);
        transceiver.addTrack(
          announced
            ? transceiver.receiver.adoptDefaultTrack(encode.ssrc, codec)
            : new MediaStreamTrack({
                ssrc: encode.ssrc,
                kind: transceiver.kind,
                id: transceiver.sender.trackId,
                remote: true,
                codec,
              }),
        );
        if (encode.rtx) {
          this.registerRtpReceiver(
            transceiver.receiver,
            encode.rtx.ssrc,
            deferConflicts,
          );
        }
      });

    // The RTX SSRC of a RID layer routes to the receiver; its media SSRC is
    // learned from the RID of the packets.
    for (const { rtxSsrc } of params.ridRtxPairs ?? []) {
      // A pending description leaves a route this receiver already has for
      // the RTX SSRC (learned from a repaired RID): taking it as a
      // description route would lose it at a rollback.
      if (
        deferConflicts &&
        this.routes.of(rtxSsrc).some((r) => r.endpoint === transceiver.receiver)
      ) {
        continue;
      }
      this.registerRtpReceiver(transceiver.receiver, rtxSsrc, deferConflicts);
    }

    this.registerHeaderExtensions(params);
  }

  private registerHeaderExtensions(params: RTCRtpReceiveParameters) {
    params.headerExtensions.forEach((extension) => {
      this.extIdUriMap[extension.id] = extension.uri;
    });
  }

  registerRtpReceiverByRid(
    transceiver: RTCRtpTransceiver,
    param: RTCRtpSimulcastParameters,
    params: RTCRtpReceiveParameters,
    { deferConflicts = false }: { deferConflicts?: boolean } = {},
  ) {
    // RTX / RED は track の codec にしない。RID ごとの RTX SSRC は
    // repaired-rtp-stream-id 付きパケットから学習する (routeRtp)。
    const codec = primaryTrackCodec(transceiver.kind, params.codecs);

    log("registerRtpReceiverByRid", param);
    if (this.defersRemote(transceiver, deferConflicts)) {
      const deferred = (transceiver.receiver.deferredRemote ??= {
        params,
        simulcast: [],
      });
      deferred.params = params;
      if (!deferred.simulcast.some((p) => p.rid === param.rid)) {
        deferred.simulcast.push(param);
      }
      return;
    }
    transceiver.addTrack(
      new MediaStreamTrack({
        rid: param.rid,
        kind: transceiver.kind,
        id: transceiver.sender.trackId,
        remote: true,
        codec,
      }),
    );
    // The m-line has RIDs now. A learned SSRC that already carried this RID
    // (while a pending description gave it, as answerer or offerer) is that
    // RID's media SSRC; the other learned SSRCs go at the commit
    // (`commitStaged`), once every RID of the description registered.
    if (!deferConflicts) this.adoptCarriedRid(transceiver.receiver, param.rid);
    const key = ridRouteKey(transceiver.mid ?? "", param.rid);
    const existing = this.ridTable[key];
    if (deferConflicts && existing && existing !== transceiver.receiver) {
      this.stagedRid.set(key, transceiver.receiver);
      return;
    }
    this.stagedRid.delete(key);
    this.ridTable[key] = transceiver.receiver;
  }

  /**
   * Simulcast (RFC 8852): a packet with `rtp-stream-id` is a layer's media,
   * one with `repaired-rtp-stream-id` is the RTX stream repairing that layer.
   * The first such packet registers its SSRC as a learned route, because the
   * sender may stop sending these extensions (libwebrtc does once it receives
   * an RTCP RR); later packets of the SSRC are routed by SSRC alone.
   */
  routeRtp = (packet: RtpPacket, dtlsTransport?: RTCDtlsTransport) => {
    const extensions: Extensions = rtpHeaderExtensionsParser(
      packet.header.extensions,
      this.extIdUriMap,
    );
    const { ssrc } = packet.header;
    const mid = extensions[RTP_EXTENSION_URI.sdesMid];
    let learnedNow = false;

    const route = this.endpointBySsrc(ssrc, dtlsTransport);
    // A remote stream may use the SSRC of a local sender (RFC 3550 section
    // 8.2 collision): the sender keeps its route and receives no RTP.
    // This applies before any RID or repaired RID: an identifier of the
    // packet never takes a sender's SSRC of its RTP session from the sender
    // (the RTP would reach a receiver while the RTCP reaches the sender).
    if (route && !(route instanceof RTCRtpReceiver)) {
      log("ssrc of a local sender", ssrc);
      return;
    }
    let rtpReceiver = route as RTCRtpReceiver | undefined;

    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID];
    const repairedRid = extensions[RTP_EXTENSION_URI.repairedRtpStreamId];
    const repairedReceiver =
      typeof rid !== "string" &&
      typeof repairedRid === "string" &&
      !rtpReceiver &&
      pendingRidOwner(
        this,
        repairedRid,
        mid,
        rtpReceiver,
        dtlsTransport,
        packet.header.payloadType,
      ) === "none"
        ? receiverByRid(this, repairedRid, mid, dtlsTransport)
        : undefined;
    const pendingRid =
      typeof rid === "string"
        ? pendingRidOwner(
            this,
            rid,
            mid,
            rtpReceiver,
            dtlsTransport,
            packet.header.payloadType,
          )
        : "none";
    if (pendingRid === "ambiguous") {
      log("rid of a pending and a committed m-line: ambiguous", { rid, ssrc });
      return;
    }
    const ridOfAnotherMline = pendingRid === "pending";
    const ridReceiver =
      typeof rid === "string" && !ridOfAnotherMline
        ? receiverByRid(this, rid, mid, dtlsTransport)
        : undefined;
    // A RID no route knows, on an m-line whose current session is without
    // SSRC and RID (a pending description's RID, `deferredRemote`): the packet
    // is the current session's single stream, routed and learned by SSRC.
    const ignoredRid =
      typeof rid === "string" &&
      !ridReceiver &&
      (!rtpReceiver || rtpReceiver.acceptsUnknownSsrc);
    if (typeof rid === "string" && !ridReceiver && !ignoredRid) {
      log("rid receiver not found", rid);
      return;
    }
    if (ridReceiver) {
      rtpReceiver = ridReceiver;
      learnedNow = this.learnSsrc(ssrc, rtpReceiver);
      rtpReceiver.latestRid = rid;
      rtpReceiver.handleRtpByRid(packet, rid, extensions);
    } else if (repairedReceiver) {
      rtpReceiver = repairedReceiver;
      learnedNow = this.learnSsrc(ssrc, rtpReceiver);
      rtpReceiver.handleRtxByRid(packet, repairedRid as string, extensions);
    } else if (
      rtpReceiver &&
      typeof repairedRid === "string" &&
      rtpReceiver.isFidRtxSsrc(ssrc)
    ) {
      // The SDP routes this RTX SSRC, the repaired RID names its RID.
      rtpReceiver.handleRtxByRid(packet, repairedRid, extensions);
    } else if (
      rtpReceiver &&
      dtlsTransport &&
      rtpReceiver.hasFallbackSsrc(ssrc)
    ) {
      const routed = this.routeFallbackPacket(
        packet,
        mid,
        dtlsTransport,
        rtpReceiver,
      );
      rtpReceiver = routed?.receiver;
      if (routed) {
        learnedNow = routed.learned;
        routed.receiver.handleRtpBySsrc(packet, extensions);
      }
    } else if (rtpReceiver) {
      rtpReceiver.handleRtpBySsrc(packet, extensions);
    } else {
      // simulcast after send receiver report. The SSRC a RID receiver learned
      // belongs to its RTP session: on another transport the same number is
      // another stream (for example of an SSRC-less m-line there).
      rtpReceiver = Object.values(this.ridTable)
        .filter((r): r is RTCRtpReceiver => r instanceof RTCRtpReceiver)
        .find(
          (r) =>
            r.trackBySSRC[ssrc] &&
            (!dtlsTransport || r.dtlsTransport === dtlsTransport),
        );
      if (rtpReceiver) {
        log("simulcast register receiver by ssrc", ssrc);
        learnedNow = this.learnSsrc(ssrc, rtpReceiver);
        rtpReceiver.handleRtpBySsrc(packet, extensions);
      } else {
        // An RTX SSRC is only known from SDP (ssrc-group:FID) or from a
        // repaired-rtp-stream-id: without either it is not guessed.
        rtpReceiver = this.learnUnknownSsrc(
          packet,
          mid,
          typeof repairedRid === "string",
          dtlsTransport,
        );
        if (rtpReceiver) {
          learnedNow = true;
          rtpReceiver.handleRtpBySsrc(packet, extensions);
        }
      }
    }

    if (!rtpReceiver) {
      log("ssrcReceiver not found");
      return;
    }
    if (ignoredRid) rtpReceiver.noteFallbackRid(ssrc, rid as string);
    for (const forgotten of rtpReceiver.takeForgottenSsrcs()) {
      this.unlearnSsrc(forgotten, rtpReceiver);
    }
    // 無効なパケットは経路を教えない。取り消すのはこのパケットが今追加した経路だけ。
    for (const rejected of rtpReceiver.takeRejectedSsrcs()) {
      if (learnedNow && rejected === ssrc)
        this.unlearnSsrc(rejected, rtpReceiver);
    }

    if (typeof mid === "string") {
      rtpReceiver.sdesMid = mid;
    }

    if (typeof repairedRid === "string") {
      rtpReceiver.latestRepairedRid = repairedRid;
    }
  };

  /**
   * Route an SSRC learned from a packet. Packet-driven, not a description:
   * staged routes stay as they are, and an SSRC a description routes keeps
   * that route.
   */
  private learnSsrc(ssrc: number, receiver: RTCRtpReceiver) {
    if (this.endpointBySsrc(ssrc, receiver.dtlsTransport)) return false;
    log("simulcast register receiver by ssrc", ssrc);
    return this.addLearnedRoute(ssrc, receiver);
  }

  /**
   * Add a route a packet taught `receiver`, in the RTP session of its
   * transport. False when `receiver` already has a route for `ssrc`.
   */
  private addLearnedRoute(ssrc: number, receiver: RTCRtpReceiver) {
    if (this.routes.of(ssrc).some((r) => r.endpoint === receiver)) return false;
    this.routes.add(ssrc, { endpoint: receiver, origin: RouteOrigin.learned });
    return true;
  }

  /**
   * RFC 9143 section 9.2 for an SSRC that no route, RID or simulcast track
   * knows: the receiver `unknownSsrcCandidate` (`routing/unknownSsrc.ts`)
   * chooses learns it as a fallback SSRC, with a learned route on the
   * packet's transport; otherwise the packet is dropped and the reason logged
   * once per SSRC. A learned SSRC stays learned (see
   * {@link routeFallbackPacket}), so a late packet never comes here. The same
   * SSRC on another transport is another stream with its own route
   * (`routes`), so each transport keeps its own receiver. With `handover` a
   * newer MID moves the SSRC here from another m-line.
   */
  private learnUnknownSsrc(
    packet: RtpPacket,
    mid: unknown,
    repaired: boolean,
    transport: RTCDtlsTransport | undefined,
    handover?: { from: RTCRtpReceiver; stream: FallbackStream },
  ): RTCRtpReceiver | undefined {
    const { ssrc, payloadType } = packet.header;
    const drop = (reason: UnknownSsrcDrop, detail?: object) => {
      const key = `${ssrc}\u0000${reason}`;
      if (this.lastUnknownSsrcDrop !== key) {
        this.lastUnknownSsrcDrop = key;
        log("unknown ssrc dropped:", reason, { ssrc, payloadType, ...detail });
      }
      return undefined;
    };
    const candidate = unknownSsrcCandidate(this.transceivers(), {
      mid,
      payloadType,
      repaired,
      transport,
    });
    if ("drop" in candidate) return drop(candidate.drop, candidate.detail);
    const { receiver } = candidate;

    if (handover) {
      // RFC 9143 section 9.2: a newer MID moves the SSRC to its m-line.
      log("fallback ssrc moved by mid", { ssrc, mid });
      this.releaseFallbackSsrc(handover.from, ssrc);
    }
    receiver.bindFallbackSsrc(
      ssrc,
      payloadType,
      handover?.stream ?? {
        sequenceNumber: packet.header.sequenceNumber,
        mid: typeof mid === "string",
      },
    );
    log("fallback register receiver by ssrc", ssrc);
    // An SSRC learned on another transport: this one keeps its own route.
    this.addLearnedRoute(ssrc, receiver);
    this.lastUnknownSsrcDrop = undefined;
    return receiver;
  }

  /**
   * The endpoint `ssrc` names for a packet of `transport`, for RTP and RTCP
   * alike: the highest ranked route of that RTP session (a local sender, a
   * description's receiver, a receiver packets taught; the first of a
   * rank). Routes of other transports are other streams and are not
   * reached. A learned route whose receiver no longer knows the SSRC (or
   * stopped) is dropped on the way. Without a transport every route counts.
   */
  private endpointBySsrc(ssrc: number, transport?: RTCDtlsTransport) {
    let best: Route | undefined;
    for (const route of [...this.routes.of(ssrc)]) {
      const { endpoint } = route;
      if (
        route.origin === RouteOrigin.learned &&
        endpoint instanceof RTCRtpReceiver &&
        (endpoint.stopped || !endpoint.knowsSsrc(ssrc))
      ) {
        this.routes.remove(ssrc, (r) => r === route);
        continue;
      }
      if (!sameSession(endpoint, transport)) continue;
      if (!best || ORIGIN_RANK[route.origin] > ORIGIN_RANK[best.origin]) {
        best = route;
      }
    }
    // A transceiver moved into this RTP session (a BUNDLE merge) may bring a
    // learned SSRC a sender or description route of the session outranks:
    // that receiver forgets it, as at a registration.
    if (transport && best && best.origin !== RouteOrigin.learned) {
      for (const owner of this.learnedOwnersIn(ssrc, best.endpoint)) {
        if (owner.dtlsTransport === transport) {
          this.releaseLearnedSsrc(owner, ssrc);
        }
      }
    }
    return best?.endpoint;
  }

  /**
   * A packet of a fallback SSRC `owner` learned. RFC 9143 section 9.2: a MID
   * updates the mapping only from a packet newer (extended sequence number)
   * than the last update; an older packet keeps the mapping and is delivered
   * through it. A newer MID naming another m-line moves the SSRC there when
   * that m-line may learn it; otherwise the packet is dropped (it belongs to
   * neither). Returns the receiver and whether the route changed.
   */
  private routeFallbackPacket(
    packet: RtpPacket,
    mid: unknown,
    transport: RTCDtlsTransport,
    owner: RTCRtpReceiver,
  ): { receiver: RTCRtpReceiver; learned: boolean } | undefined {
    const { ssrc, sequenceNumber, payloadType } = packet.header;
    const observed = owner.observeFallbackPacket(ssrc, sequenceNumber);
    if (!observed) return { receiver: owner, learned: false };
    const own = this.transceivers().find((t) => t.receiver === owner);
    const midUpdate = typeof mid === "string" && observed.midMayUpdate;
    if (midUpdate && own?.mid !== mid) {
      // The m-line the MID names takes the packet only with a media payload
      // type it receives (`learnUnknownSsrc`); otherwise nothing moves.
      const target = this.learnUnknownSsrc(packet, mid, false, transport, {
        from: owner,
        stream: { ...observed.stream, midUpdateExt: observed.ext },
      });
      return target ? { receiver: target, learned: true } : undefined;
    }
    // A packet the owner does not receive as media (a payload type not
    // negotiated, RTX) is dropped by the receiver: its sequence number and
    // MID must not move the mapping state either.
    if (owner.receivesMediaPayloadType(payloadType)) {
      owner.acceptFallbackPacket(ssrc, observed.ext, midUpdate);
    }
    return { receiver: owner, learned: false };
  }

  /**
   * Receivers other than `endpoint` in its RTP session that learned `ssrc`
   * from packets: as a fallback SSRC, as a RID's media SSRC or as a RID's
   * RTX SSRC.
   */
  private learnedOwnersIn(ssrc: number, endpoint: Endpoint) {
    const transport = transportOf(endpoint);
    return this.routes
      .of(ssrc)
      .filter(
        (r) => r.origin === RouteOrigin.learned && r.endpoint !== endpoint,
      )
      .map((r) => r.endpoint)
      .filter(
        (owner): owner is RTCRtpReceiver =>
          owner instanceof RTCRtpReceiver &&
          sameSession(owner, transport) &&
          (owner.hasFallbackSsrc(ssrc) || owner.knowsSsrc(ssrc)),
      );
  }

  /**
   * A description routes `ssrc` to `receiver`. A learned owner in the same
   * RTP session forgets it (the description wins); learned routes of other
   * transports stay, they are other streams. Another receiver's description
   * route in the same RTP session goes (the later description wins); one of
   * another transport stays. A sender keeps its route.
   */
  private takeSsrcRoute(ssrc: number, receiver: RTCRtpReceiver) {
    for (const owner of this.learnedOwnersIn(ssrc, receiver)) {
      this.releaseLearnedSsrc(owner, ssrc);
    }
    this.routes.remove(
      ssrc,
      (r) =>
        (r.origin === RouteOrigin.sdp &&
          r.endpoint !== receiver &&
          sameSession(r.endpoint, receiver.dtlsTransport)) ||
        (r.origin === RouteOrigin.learned && r.endpoint === receiver),
    );
    if (
      !this.routes
        .of(ssrc)
        .some((r) => r.endpoint === receiver && r.origin === RouteOrigin.sdp)
    ) {
      this.routes.add(ssrc, { endpoint: receiver, origin: RouteOrigin.sdp });
    }
  }

  /** Forget one learned fallback SSRC of `receiver` and its route. */
  private releaseFallbackSsrc(receiver: RTCRtpReceiver, ssrc: number) {
    receiver.releaseFallbackSsrc(ssrc);
    for (const forgotten of receiver.takeForgottenSsrcs()) {
      this.unlearnSsrc(forgotten, receiver);
    }
  }

  /**
   * `receiver` forgets what packets taught it about `ssrc` (a fallback SSRC,
   * a RID's media or RTX SSRC) and its learned route goes.
   */
  private releaseLearnedSsrc(receiver: RTCRtpReceiver, ssrc: number) {
    receiver.releaseLearnedSsrc(ssrc);
    for (const forgotten of receiver.takeForgottenSsrcs()) {
      this.unlearnSsrc(forgotten, receiver);
    }
    this.unlearnSsrc(ssrc, receiver);
  }

  /** Forget every learned fallback SSRC of `receiver` and their routes. */
  private releaseFallbackSsrcs(receiver: RTCRtpReceiver) {
    receiver.releaseFallbackSsrcs();
    for (const forgotten of receiver.takeForgottenSsrcs()) {
      this.unlearnSsrc(forgotten, receiver);
    }
  }

  /** Drop a learned route of `receiver`; a description's route stays. */
  private unlearnSsrc(ssrc: number, receiver: RTCRtpReceiver) {
    this.routes.remove(
      ssrc,
      (r) => r.origin === RouteOrigin.learned && r.endpoint === receiver,
    );
  }

  /** Deliver an RTCP packet within the RTP session of `dtlsTransport` (`routing/rtcpRouting.ts`). */
  routeRtcp = (packet: RtcpPacket, dtlsTransport?: RTCDtlsTransport) => {
    routeRtcpPacket(packet, dtlsTransport, {
      endpointBySsrc: (ssrc, transport) => this.endpointBySsrc(ssrc, transport),
      endpoints: () => this.routes.entries().map((r) => r.endpoint),
      keyFrameRequestRouting: this.keyFrameRequestRouting,
    });
  };
}
