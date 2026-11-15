import {
  type CompatibilityOptionValue,
  CompatibilityOptionValues,
} from "../api/compatibilityOptions";
import {
  debug,
  type Extensions,
  FullIntraRequest,
  PictureLossIndication,
  ReceiverEstimatedMaxBitrate,
  RTP_EXTENSION_URI,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  type RtpPacket,
  rtpHeaderExtensionsParser,
  TransportWideCC,
} from "../imports/rtp";
import { type RouterSnapshot, ridRouteKey } from "../negotiation/internalState";
import type { RTCDtlsTransport } from "../transport/dtls";
import { deliveredTrackCodec, primaryTrackCodec } from "./codecCompatibility";
import type {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { type FallbackStream, RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import type { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/router.ts");

/**
 * Where a keyframe request (PLI / FIR) goes when no route has its target SSRC.
 * - `"fallback"` (default): the sender whose RTX SSRC it is, else the only
 *   video sender of the PeerConnection, so that a request naming the RTX
 *   stream, SSRC 0 or a stale SSRC still gets a keyframe.
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

const ridOfRouteKey = (key: string) => key.slice(key.indexOf("\u0000") + 1);

/**
 * Why a packet with an SSRC no route knows was not learned (debug log).
 * @enum
 */
const UnknownSsrcDrop = {
  noTransport: "no transport",
  rtx: "rtx",
  midMismatch: "mid mismatch",
  transportMismatch: "transport mismatch",
  notReceiving: "not receiving",
  hasSsrc: "m-line has ssrc or rid",
  unknownPayloadType: "unknown payload type",
  noCandidate: "no candidate",
  ambiguous: "ambiguous",
} as const;
type UnknownSsrcDrop = (typeof UnknownSsrcDrop)[keyof typeof UnknownSsrcDrop];

type StagedRoutes = {
  ssrc: [number, RTCRtpReceiver][];
  rid: [string, RTCRtpReceiver][];
  provisional?: [number, RTCRtpReceiver][];
};

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
 * | SSRC → receiver | `ssrcTable` | move to another m-line staged |
 * | RTX SSRC → media SSRC | receiver RTX table | changed pairing staged |
 * | MID+RID → receiver | `ridTable` | RIDs are scoped to their m-line (RFC 8851): no conflict |
 * | Sender SSRC → sender | `ssrcTable` | application state: rollback keeps every live sender's route |
 *
 * Packet-driven routes are not description state: an SSRC first seen with
 * `rtp-stream-id` / `repaired-rtp-stream-id` is added to `ssrcTable` as
 * learned (`learnedSsrcs`), and the receiver learns RID → media SSRC and RTX
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
 * An SSRC is unique per RTP session only: a receiver route, from a
 * description or learned from packets, belongs to its receiver's current
 * transport (a transceiver moved to another transport takes it along, and
 * the old transport no longer reaches it). RTP and RTCP (SR, RR and every
 * feedback naming an SSRC) arriving on another transport never resolve to
 * it; that transport's receiver learning the same numeric SSRC (fallback or
 * RID) keeps its own route (`collidingRoutes`), and a description giving
 * the SSRC to a receiver of another transport than its learned owner's
 * moves the learned route aside instead of taking it. Within one RTP
 * session a description's SSRC wins over a learned one (the learning
 * receiver forgets it). Sender routes are not scoped by transport. A remote
 * stream using a local sender's SSRC is not learned.
 *
 * A payload type or extension ID counts as in use only when both current
 * descriptions carry it for the m-line. RID lookup uses MID+RID when the
 * packet's MID names a route, else the RID alone. `extIdUriMap` is shared by
 * the whole PeerConnection: m-lines on separate transports that map one ID to
 * different URIs are not supported. A current remote SSRC that a later answer
 * omits stays routed; only SSRCs a replaced pranswer alone added are dropped.
 */
export class RtpRouter {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver | RTCRtpSender } = {};
  /** Keyed by {@link ridRouteKey} (MID + RID). */
  ridTable: { [midAndRid: string]: RTCRtpReceiver | RTCRtpSender } = {};
  /**
   * Routes a pending offer or pranswer would move away from the receiver the
   * current session uses. They apply at commit; until then current RTP keeps
   * its route, and rollback drops them.
   */
  private stagedSsrc = new Map<number, RTCRtpReceiver>();
  private stagedRid = new Map<string, RTCRtpReceiver>();
  /**
   * New SSRC routes a pending description added at once (no conflict). A
   * later remote pranswer / answer replaces them, the commit keeps them.
   */
  private provisionalSsrc = new Map<number, RTCRtpReceiver>();
  extIdUriMap: { [id: number]: string } = {};
  /**
   * SSRCs registered from received packets (simulcast after RID stops being
   * sent), not from SDP. Negotiation rollback keeps these entries.
   */
  readonly learnedSsrcs = new Set<number>();
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
  /**
   * Fallback routes whose SSRC `ssrcTable` already holds for a receiver of
   * another transport (an SSRC is unique per RTP session only). Packet-driven
   * like `learnedSsrcs`, not part of a negotiation baseline: an entry is
   * valid only while its receiver still has the SSRC as a track. Keyed by
   * SSRC, not by transport: like a learned route of `ssrcTable`, an entry
   * belongs to the receiver's current `dtlsTransport`, so a transceiver
   * moved to another transport stops answering on the old one.
   * RTP and RTCP resolve it alike ({@link endpointBySsrc}).
   */
  private collidingRoutes = new Map<number, Set<RTCRtpReceiver>>();
  /** Last logged drop of an unknown SSRC, so a stream logs a reason once. */
  private lastUnknownSsrcDrop?: string;

  constructor() {}

  registerRtpSender(sender: RTCRtpSender) {
    this.ssrcTable[sender.ssrc] = sender;
    this.learnedSsrcs.delete(sender.ssrc);
  }

  /** Internal: the negotiation committed, staged routes replace current ones. */
  commitStaged() {
    for (const [ssrc, receiver] of this.stagedSsrc) {
      this.takeSsrcRoute(ssrc, receiver);
      this.learnedSsrcs.delete(ssrc);
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
      if (this.ssrcTable[ssrc] === receiver && !this.learnedSsrcs.has(ssrc)) {
        delete this.ssrcTable[ssrc];
        receiver.releaseProvisionalSsrc(ssrc);
      }
    }
    this.provisionalSsrc.clear();
  }

  /** Internal: capture staged routes for a transaction baseline or checkpoint. */
  snapshotStaged(): StagedRoutes {
    return {
      ssrc: [...this.stagedSsrc],
      rid: [...this.stagedRid],
      provisional: [...this.provisionalSsrc],
    };
  }

  /** Internal: restore staged routes (an empty snapshot discards them). */
  restoreStaged(snapshot: StagedRoutes) {
    this.stagedSsrc = new Map(snapshot.ssrc);
    this.stagedRid = new Map(snapshot.rid);
    this.provisionalSsrc = new Map(snapshot.provisional);
  }

  /** Internal: every route a negotiation may change, for a rollback baseline. */
  snapshotRoutes() {
    return {
      ssrcTable: { ...this.ssrcTable },
      ridTable: { ...this.ridTable },
      extIdUriMap: { ...this.extIdUriMap },
      staged: this.snapshotStaged(),
      /** Routes of `ssrcTable` that packets taught (not description state). */
      learnedSsrcs: [...this.learnedSsrcs],
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
    // A route packets taught wins over a baseline route packets taught too
    // (the SSRC moved to another receiver after the baseline); a baseline
    // route of a description comes back.
    const baselineLearned = new Set(snapshot.learnedSsrcs);
    const learnedRoutes = Object.entries(this.ssrcTable).filter(
      ([ssrc, endpoint]) =>
        this.learnedSsrcs.has(Number(ssrc)) &&
        (!(ssrc in snapshot.ssrcTable) || baselineLearned.has(Number(ssrc))) &&
        endpoints.has(endpoint),
    );
    const forgotten = snapshot.learnedSsrcs.filter(
      (ssrc) => !(ssrc in this.ssrcTable),
    );
    this.ssrcTable = { ...snapshot.ssrcTable };
    for (const ssrc of forgotten) delete this.ssrcTable[ssrc];
    for (const [ssrc, endpoint] of learnedRoutes) {
      this.ssrcTable[Number(ssrc)] = endpoint;
    }
    // A baseline route packets taught stays learned, even if the rolled-back
    // description named the same SSRC (which cleared the mark).
    for (const ssrc of snapshot.learnedSsrcs) {
      if (ssrc in this.ssrcTable) this.learnedSsrcs.add(ssrc);
    }
    for (const sender of liveSenders) {
      if (!(sender.ssrc in this.ssrcTable)) this.registerRtpSender(sender);
    }
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
    for (const ssrc of [...this.collidingRoutes.keys()]) {
      this.dropCollidingRoute(ssrc, transceiver.receiver);
    }
    for (const [ssrc, receiver] of this.stagedSsrc) {
      if (receiver === transceiver.receiver) this.stagedSsrc.delete(ssrc);
    }
    for (const [key, receiver] of this.stagedRid) {
      if (receiver === transceiver.receiver) this.stagedRid.delete(key);
    }
    for (const [ssrc, endpoint] of Object.entries(this.ssrcTable)) {
      if (
        endpoint === transceiver.sender ||
        endpoint === transceiver.receiver
      ) {
        delete this.ssrcTable[Number(ssrc)];
        this.learnedSsrcs.delete(Number(ssrc));
      }
    }
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
    const existing = this.ssrcTable[ssrc];
    // A route of the current session in the same RTP session (a sender, a
    // receiver on the same transport, or a learned owner there) keeps the
    // SSRC until the commit. A learned route of another transport is another
    // stream: it stays beside this one (`collidingRoutes`).
    const conflicts =
      !!existing &&
      existing !== receiver &&
      !this.movesAside(ssrc, existing, receiver);
    if (
      deferConflicts &&
      (conflicts || this.fallbackOwners(ssrc, receiver).length > 0)
    ) {
      this.stagedSsrc.set(ssrc, receiver);
      return;
    }
    if (deferConflicts && !existing) this.provisionalSsrc.set(ssrc, receiver);
    if (!deferConflicts) this.provisionalSsrc.delete(ssrc);
    this.stagedSsrc.delete(ssrc);
    this.takeSsrcRoute(ssrc, receiver);
    // Registration from SDP makes the route description state again; the
    // packet path re-marks it as learned right after this call.
    this.learnedSsrcs.delete(ssrc);
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

    const hasSsrcs = params.encodings.some((e) => e.ssrc != undefined);
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
   * A RID a packet carries belongs to an m-line without SSRC and RID (a
   * pending description's RID, see `deferredRemote`), so it must not be
   * looked up on another m-line that uses the same RID: the m-line the packet
   * names (its MID, else its SSRC's route) is SSRC-less and has no route for
   * the RID, or, for a packet naming none, an SSRC-less m-line of the
   * transport waits for this RID.
   */
  private isPendingRidOfSsrcLess(
    rid: string,
    mid: unknown,
    route: RTCRtpReceiver | undefined,
    transport: RTCDtlsTransport | undefined,
  ) {
    const owner =
      typeof mid === "string"
        ? this.transceivers().find((t) => t.mid === mid)
        : this.transceivers().find((t) => !!route && t.receiver === route);
    if (owner) {
      return (
        owner.receiver.acceptsUnknownSsrc &&
        !this.ridTable[ridRouteKey(owner.mid ?? "", rid)]
      );
    }
    return this.transceivers().some(
      (t) =>
        (!transport || t.receiver.dtlsTransport === transport) &&
        !!t.receiver.deferredRemote?.simulcast.some((p) => p.rid === rid),
    );
  }

  /**
   * The receiver of an RTP stream ID: by MID and RID when the packet carries
   * a MID extension that names a route, otherwise (no MID extension, or a MID
   * value no route uses) the first m-line that uses that RID, as develop does.
   */
  private receiverByRid(rid: string, mid: unknown) {
    if (typeof mid === "string") {
      const byMid = this.ridTable[ridRouteKey(mid, rid)];
      if (byMid) return byMid as RTCRtpReceiver;
    }
    const key = Object.keys(this.ridTable).find(
      (candidate) => ridOfRouteKey(candidate) === rid,
    );
    return key ? (this.ridTable[key] as RTCRtpReceiver) : undefined;
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
    const senderSsrc = !!route && !(route instanceof RTCRtpReceiver);
    let rtpReceiver: RTCRtpReceiver | undefined = senderSsrc
      ? undefined
      : (route as RTCRtpReceiver | undefined);

    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID];
    const repairedRid = extensions[RTP_EXTENSION_URI.repairedRtpStreamId];
    const repairedReceiver =
      typeof rid !== "string" &&
      typeof repairedRid === "string" &&
      !rtpReceiver &&
      !this.isPendingRidOfSsrcLess(repairedRid, mid, rtpReceiver, dtlsTransport)
        ? this.receiverByRid(repairedRid, mid)
        : undefined;
    const ridOfAnotherMline =
      typeof rid === "string" &&
      this.isPendingRidOfSsrcLess(rid, mid, rtpReceiver, dtlsTransport);
    const ridReceiver =
      typeof rid === "string" && !ridOfAnotherMline
        ? this.receiverByRid(rid, mid)
        : undefined;
    // A RID no route knows, on an m-line whose current session is without
    // SSRC and RID (a pending description's RID, `deferredRemote`): the packet
    // is the current session's single stream, routed and learned by SSRC.
    const ignoredRid =
      typeof rid === "string" &&
      !ridReceiver &&
      (rtpReceiver ? rtpReceiver.acceptsUnknownSsrc : !senderSsrc);
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
      } else if (senderSsrc) {
        log("ssrc of a local sender", ssrc);
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
    const owner = this.ssrcTable[ssrc];
    if (owner && !this.isForeignRoute(owner, receiver.dtlsTransport)) {
      return false;
    }
    log("simulcast register receiver by ssrc", ssrc);
    return this.addLearnedRoute(ssrc, receiver);
  }

  /**
   * Add a route a packet taught `receiver`, in the RTP session of its
   * transport: an SSRC `ssrcTable` holds as learned for another transport's
   * receiver goes to `collidingRoutes` (an SSRC is unique per RTP session
   * only), otherwise to `ssrcTable`. False when the route already exists.
   */
  private addLearnedRoute(ssrc: number, receiver: RTCRtpReceiver) {
    const transport = receiver.dtlsTransport;
    const owner = this.ssrcTable[ssrc];
    if (owner && this.isForeignRoute(owner, transport)) {
      let routes = this.collidingRoutes.get(ssrc);
      if (!routes) this.collidingRoutes.set(ssrc, (routes = new Set()));
      if (routes.has(receiver)) return false;
      routes.add(receiver);
      return true;
    }
    this.ssrcTable[ssrc] = receiver;
    this.learnedSsrcs.add(ssrc);
    return true;
  }

  /**
   * RFC 9143 section 9.2 for an SSRC that no route, RID or simulcast track
   * knows. Without the transport the packet arrived on nothing is learned.
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
   * nothing pairs it with the media SSRC. A learned SSRC stays learned (see
   * {@link routeFallbackPacket}), so a late packet never comes here.
   * An SSRC `ssrcTable` holds for another transport's receiver is routed
   * through `collidingRoutes`, so each transport keeps its own receiver.
   * Receiving is decided by the committed `currentDirection`; a pending
   * description decides only before the first commit.
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
    if (!transport) return drop(UnknownSsrcDrop.noTransport);
    if (repaired) return drop(UnknownSsrcDrop.rtx);
    // The committed session decides: `currentDirection` is the negotiated
    // direction, so a pending offer that changes `direction`, the remote
    // direction (`firedReceiving`) or marks a rejection leaves a running
    // stream receiving until the transaction commits. Only before the first
    // commit (no `currentDirection`) the provisional description decides.
    const receiving = (t: RTCRtpTransceiver) => {
      if (t.stopped || t.stopping) return false;
      const current = t.currentDirection;
      if (current) return current === "recvonly" || current === "sendrecv";
      return (
        ["recvonly", "sendrecv"].includes(t.direction) &&
        t.firedReceiving &&
        !t.pendingRejection
      );
    };

    let receiver: RTCRtpReceiver;
    if (typeof mid === "string") {
      const transceiver = this.transceivers().find((t) => t.mid === mid);
      if (!transceiver) return drop(UnknownSsrcDrop.midMismatch, { mid });
      receiver = transceiver.receiver;
      if (receiver.dtlsTransport !== transport) {
        return drop(UnknownSsrcDrop.transportMismatch, { mid });
      }
      if (!receiving(transceiver)) {
        return drop(UnknownSsrcDrop.notReceiving, { mid });
      }
      if (!receiver.acceptsUnknownSsrc) {
        return drop(UnknownSsrcDrop.hasSsrc, { mid });
      }
      if (!receiver.receivesMediaPayloadType(payloadType)) {
        return drop(
          receiver.receivesRtxPayloadType(payloadType)
            ? UnknownSsrcDrop.rtx
            : UnknownSsrcDrop.unknownPayloadType,
          { mid },
        );
      }
    } else {
      // A payload type names an m-line only when no other m-line of the RTP
      // session receives it (RFC 9143 section 9.2): every receiving m-line
      // on the transport counts, with or without `a=ssrc` or RIDs, and as
      // media or RTX. Only then may the one m-line be a candidate.
      const onTransport = this.transceivers().filter(
        (t) => t.receiver.dtlsTransport === transport && receiving(t),
      );
      const byPayloadType = onTransport.filter(
        (t) =>
          t.receiver.receivesMediaPayloadType(payloadType) ||
          t.receiver.receivesRtxPayloadType(payloadType),
      );
      const mids = byPayloadType.map((t) => t.mid);
      if (byPayloadType.length === 0) {
        return drop(
          onTransport.some((t) => t.receiver.acceptsUnknownSsrc)
            ? UnknownSsrcDrop.unknownPayloadType
            : UnknownSsrcDrop.noCandidate,
        );
      }
      if (byPayloadType.length > 1) {
        return drop(UnknownSsrcDrop.ambiguous, { mids });
      }
      receiver = byPayloadType[0].receiver;
      if (receiver.receivesRtxPayloadType(payloadType)) {
        return drop(UnknownSsrcDrop.rtx, { mids });
      }
      if (!receiver.acceptsUnknownSsrc) {
        return drop(UnknownSsrcDrop.hasSsrc, { mids });
      }
    }

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
   * alike. An SSRC is unique per RTP session only: a route a packet taught
   * belongs to its receiver's current transport, so a packet of another
   * transport resolves to that transport's own route (`collidingRoutes`) or
   * to none. Without a transport `ssrcTable` decides.
   */
  private endpointBySsrc(ssrc: number, transport?: RTCDtlsTransport) {
    const colliding = this.collidingRoute(transport, ssrc);
    if (colliding) return colliding;
    const route = this.ssrcTable[ssrc];
    if (route && this.isForeignRoute(route, transport)) {
      return undefined;
    }
    return route;
  }

  private collidingRoute(
    transport: RTCDtlsTransport | undefined,
    ssrc: number,
  ) {
    const routes = transport && this.collidingRoutes.get(ssrc);
    if (!routes) return undefined;
    let found: RTCRtpReceiver | undefined;
    for (const receiver of [...routes]) {
      if (!receiver.trackBySSRC[ssrc] || receiver.stopped) {
        this.dropCollidingRoute(ssrc, receiver);
      } else if (!found && receiver.dtlsTransport === transport) {
        found = receiver;
      }
    }
    return found;
  }

  private dropCollidingRoute(ssrc: number, receiver: RTCRtpReceiver) {
    const routes = this.collidingRoutes.get(ssrc);
    if (!routes?.delete(receiver)) return;
    if (routes.size === 0) this.collidingRoutes.delete(ssrc);
  }

  /**
   * A receiver route (from a description or taught by packets) of another
   * RTP session than `transport`: an SSRC is unique per RTP session only, so
   * a packet of `transport` does not reach it. Sender routes are not scoped.
   */
  private isForeignRoute(
    route: RTCRtpReceiver | RTCRtpSender,
    transport: RTCDtlsTransport | undefined,
  ) {
    return (
      !!transport &&
      route instanceof RTCRtpReceiver &&
      route.dtlsTransport !== transport
    );
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
    const { ssrc, sequenceNumber } = packet.header;
    const observed = owner.observeFallbackPacket(ssrc, sequenceNumber);
    if (!observed || typeof mid !== "string" || !observed.midMayUpdate) {
      return { receiver: owner, learned: false };
    }
    const own = this.transceivers().find((t) => t.receiver === owner);
    if (own?.mid === mid) {
      owner.markFallbackMidUpdate(ssrc, observed.ext);
      return { receiver: owner, learned: false };
    }
    const target = this.learnUnknownSsrc(packet, mid, false, transport, {
      from: owner,
      stream: { ...observed.stream, midUpdateExt: observed.ext },
    });
    return target ? { receiver: target, learned: true } : undefined;
  }

  /**
   * A description routes `ssrc` to `receiver`: a receiver that learned it
   * as a fallback SSRC (on any transport, SDP routes are not scoped by
   * transport) forgets it, so its track and statistics no longer show it.
   */
  private releaseFallbackOwner(ssrc: number, receiver: RTCRtpReceiver) {
    for (const owner of this.fallbackOwners(ssrc, receiver)) {
      this.releaseFallbackSsrc(owner, ssrc);
    }
  }

  /**
   * Receivers other than `receiver` in its RTP session (same transport) that
   * learned `ssrc` as a fallback SSRC.
   */
  private fallbackOwners(ssrc: number, receiver: RTCRtpReceiver) {
    return [
      this.ssrcTable[ssrc],
      ...(this.collidingRoutes.get(ssrc) ?? []),
    ].filter(
      (owner): owner is RTCRtpReceiver =>
        owner instanceof RTCRtpReceiver &&
        owner !== receiver &&
        owner.dtlsTransport === receiver.dtlsTransport &&
        owner.hasFallbackSsrc(ssrc),
    );
  }

  /** `existing`, the `ssrcTable` route of `ssrc`, is a learned route of another RTP session than `receiver`'s. */
  private movesAside(
    ssrc: number,
    existing: RTCRtpReceiver | RTCRtpSender,
    receiver: RTCRtpReceiver,
  ) {
    return (
      this.learnedSsrcs.has(ssrc) &&
      existing instanceof RTCRtpReceiver &&
      existing.dtlsTransport !== receiver.dtlsTransport
    );
  }

  /**
   * A description routes `ssrc` to `receiver`. A learned owner in the same
   * RTP session forgets it; a learned route of another transport moves to
   * `collidingRoutes` and keeps receiving its own stream there.
   */
  private takeSsrcRoute(ssrc: number, receiver: RTCRtpReceiver) {
    this.releaseFallbackOwner(ssrc, receiver);
    const existing = this.ssrcTable[ssrc];
    if (
      existing &&
      existing !== receiver &&
      this.movesAside(ssrc, existing, receiver)
    ) {
      let routes = this.collidingRoutes.get(ssrc);
      if (!routes) this.collidingRoutes.set(ssrc, (routes = new Set()));
      routes.add(existing as RTCRtpReceiver);
    }
    this.dropCollidingRoute(ssrc, receiver);
    this.ssrcTable[ssrc] = receiver;
  }

  /** Forget one learned fallback SSRC of `receiver` and its route. */
  private releaseFallbackSsrc(receiver: RTCRtpReceiver, ssrc: number) {
    receiver.releaseFallbackSsrc(ssrc);
    for (const forgotten of receiver.takeForgottenSsrcs()) {
      this.unlearnSsrc(forgotten, receiver);
    }
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
    this.dropCollidingRoute(ssrc, receiver);
    if (!this.learnedSsrcs.has(ssrc) || this.ssrcTable[ssrc] !== receiver) {
      return;
    }
    log("forget learned ssrc", ssrc);
    delete this.ssrcTable[ssrc];
    this.learnedSsrcs.delete(ssrc);
  }

  routeRtcp = (packet: RtcpPacket, dtlsTransport?: RTCDtlsTransport) => {
    const recipients: (RTCRtpReceiver | RTCRtpSender | undefined)[] = [];

    switch (packet.type) {
      case RtcpSrPacket.type:
        {
          packet = packet as RtcpSrPacket;
          recipients.push(this.endpointBySsrc(packet.ssrc, dtlsTransport));
        }
        break;
      case RtcpRrPacket.type:
        {
          packet = packet as RtcpRrPacket;
          packet.reports.forEach((report) => {
            recipients.push(this.endpointBySsrc(report.ssrc, dtlsTransport));
          });
        }
        break;
      case RtcpSourceDescriptionPacket.type:
        {
          const sdes = packet as RtcpSourceDescriptionPacket;
          // log("sdes", JSON.stringify(sdes.chunks));
        }
        break;
      case RtcpTransportLayerFeedback.type:
        {
          const rtpfb = packet as RtcpTransportLayerFeedback;
          if (rtpfb.feedback?.count === TransportWideCC.count) {
            recipients.push(
              ...this.twccFeedbackRecipients(rtpfb, dtlsTransport),
            );
          } else if (rtpfb.feedback) {
            recipients.push(
              this.endpointBySsrc(
                rtpfb.feedback.mediaSourceSsrc,
                dtlsTransport,
              ),
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
                  this.endpointBySsrc(remb.ssrcFeedbacks[0], dtlsTransport),
                );
              }
              break;
            case PictureLossIndication.count:
              // RFC 4585 6.1: the target is the media source, never the sender of the feedback
              {
                const target = this.keyFrameRequestTarget(
                  psfb.feedback.mediaSsrc,
                  dtlsTransport,
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
                    recipients.push(
                      this.endpointBySsrc(fir.mediaSsrc, dtlsTransport),
                    );
                  }
                  break;
                }
                const targets = new Map<
                  RTCRtpReceiver | RTCRtpSender,
                  FirEntry[]
                >();
                for (const entry of fir.fir) {
                  const target = this.keyFrameRequestTarget(
                    entry.ssrc,
                    dtlsTransport,
                  );
                  if (target) {
                    targets.set(target, [
                      ...(targets.get(target) ?? []),
                      entry,
                    ]);
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
                this.endpointBySsrc(psfb.feedback.mediaSsrc, dtlsTransport),
              );
          }
        }
        break;
    }
    recipients
      .filter((v): v is RTCRtpReceiver | RTCRtpSender => !!v) // todo simulcast
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };

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
  private twccFeedbackRecipients(
    rtpfb: RtcpTransportLayerFeedback,
    incomingTransport?: RTCDtlsTransport,
  ): (RTCRtpReceiver | RTCRtpSender)[] {
    if (incomingTransport) {
      return this.sendersOnTransport(incomingTransport);
    }
    const seed = this.ssrcTable[rtpfb.feedback.mediaSourceSsrc];
    const transport =
      seed && "dtlsTransport" in seed ? seed.dtlsTransport : undefined;
    const senders = this.sendersOnTransport(transport);
    if (senders.length > 0) {
      return senders;
    }
    return seed ? [seed] : [];
  }

  private sendersOnTransport(transport?: RTCDtlsTransport): RTCRtpSender[] {
    const seen = new Set<RTCRtpSender>();
    const out: RTCRtpSender[] = [];
    for (const recipient of Object.values(this.ssrcTable)) {
      if (!recipient || recipient.type !== "sender") {
        continue;
      }
      const sender = recipient as RTCRtpSender;
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
  private keyFrameRequestTarget(
    ssrc: number,
    transport?: RTCDtlsTransport,
  ): RTCRtpReceiver | RTCRtpSender | undefined {
    const route = this.endpointBySsrc(ssrc, transport);
    if (route || this.keyFrameRequestRouting === "standard") return route;

    const senders = new Set(
      Object.values(this.ssrcTable).filter(
        (endpoint): endpoint is RTCRtpSender =>
          !(endpoint instanceof RTCRtpReceiver) && !endpoint.stopped,
      ),
    );
    // RFC 4585 / RFC 4588 では、キーフレーム要求(PLI/FIR)の宛先は再送用(RTX)ではなく
    // 元のメディアストリームの SSRC であることが前提で、libwebrtc もメディア SSRC 宛に送る。
    // そのため strict では RTX SSRC を解決しない。ここは RTX SSRC 宛に送ってくる
    // 非準拠な相手向けの compatible 限定の救済措置。
    const rtxOwner = [...senders].find((sender) => sender.rtxSsrc === ssrc);
    if (rtxOwner) return rtxOwner;
    const videoSenders = [...senders].filter(
      (sender) => sender.kind === "video",
    );
    return videoSenders.length === 1 ? videoSenders[0] : undefined;
  }
}
