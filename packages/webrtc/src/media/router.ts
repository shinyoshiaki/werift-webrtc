import {
  type Extensions,
  RTP_EXTENSION_URI,
  ReceiverEstimatedMaxBitrate,
  type RtcpPacket,
  RtcpPayloadSpecificFeedback,
  RtcpRrPacket,
  RtcpSourceDescriptionPacket,
  RtcpSrPacket,
  RtcpTransportLayerFeedback,
  type RtpPacket,
  debug,
  rtpHeaderExtensionsParser,
} from "../imports/rtp";
import { type RouterSnapshot, ridRouteKey } from "../negotiation/internalState";
import { deliveredTrackCodec } from "./codecCompatibility";
import type {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import type { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./track";

const log = debug("werift:packages/webrtc/src/media/router.ts");

const ridOfRouteKey = (key: string) => key.slice(key.indexOf("\u0000") + 1);

type StagedRoutes = {
  ssrc: [number, RTCRtpReceiver][];
  rid: [string, RTCRtpReceiver][];
};

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
  extIdUriMap: { [id: number]: string } = {};
  /**
   * SSRCs registered from received packets (simulcast after RID stops being
   * sent), not from SDP. Negotiation rollback keeps these entries.
   */
  readonly learnedSsrcs = new Set<number>();

  constructor() {}

  registerRtpSender(sender: RTCRtpSender) {
    this.ssrcTable[sender.ssrc] = sender;
    this.learnedSsrcs.delete(sender.ssrc);
  }

  /** Internal: the negotiation committed, staged routes replace current ones. */
  commitStaged() {
    for (const [ssrc, receiver] of this.stagedSsrc) {
      this.ssrcTable[ssrc] = receiver;
      this.learnedSsrcs.delete(ssrc);
    }
    for (const [key, receiver] of this.stagedRid) {
      this.ridTable[key] = receiver;
    }
    this.stagedSsrc.clear();
    this.stagedRid.clear();
  }

  /** Internal: capture staged routes for a transaction baseline or checkpoint. */
  snapshotStaged(): StagedRoutes {
    return { ssrc: [...this.stagedSsrc], rid: [...this.stagedRid] };
  }

  /** Internal: restore staged routes (an empty snapshot discards them). */
  restoreStaged(snapshot: StagedRoutes) {
    this.stagedSsrc = new Map(snapshot.ssrc);
    this.stagedRid = new Map(snapshot.rid);
  }

  /** Internal: every route a negotiation may change, for a rollback baseline. */
  snapshotRoutes() {
    return {
      ssrcTable: { ...this.ssrcTable },
      ridTable: { ...this.ridTable },
      extIdUriMap: { ...this.extIdUriMap },
      staged: this.snapshotStaged(),
    };
  }

  /**
   * Internal: return to a negotiation baseline. Two kinds of route are not
   * description state and survive: SSRCs learned from packets for an endpoint
   * still attached, and the own SSRC of every live sender (including one the
   * application added while the description was pending).
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
    const learnedRoutes = Object.entries(this.ssrcTable).filter(
      ([ssrc, endpoint]) =>
        this.learnedSsrcs.has(Number(ssrc)) &&
        !(ssrc in snapshot.ssrcTable) &&
        endpoints.has(endpoint),
    );
    this.ssrcTable = { ...snapshot.ssrcTable };
    for (const [ssrc, endpoint] of learnedRoutes) {
      this.ssrcTable[Number(ssrc)] = endpoint;
    }
    for (const sender of liveSenders) {
      if (!(sender.ssrc in this.ssrcTable)) this.registerRtpSender(sender);
    }
    this.ridTable = { ...snapshot.ridTable };
    this.extIdUriMap = { ...snapshot.extIdUriMap };
    this.restoreStaged(snapshot.staged);
  }

  /** Test-only observation of staged routes. */
  get staged() {
    return this.snapshotStaged();
  }

  unregisterTransceiver(transceiver: RTCRtpTransceiver) {
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
    if (deferConflicts && existing && existing !== receiver) {
      this.stagedSsrc.set(ssrc, receiver);
      return;
    }
    this.stagedSsrc.delete(ssrc);
    this.ssrcTable[ssrc] = receiver;
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

    params.encodings
      .filter((e) => e.ssrc != undefined) // todo fix
      .forEach((encode, i) => {
        this.registerRtpReceiver(
          transceiver.receiver,
          encode.ssrc,
          deferConflicts,
        );
        transceiver.addTrack(
          new MediaStreamTrack({
            ssrc: encode.ssrc,
            kind: transceiver.kind,
            id: transceiver.sender.trackId,
            remote: true,
            codec: deliveredTrackCodec(
              transceiver.kind,
              params.codecs[i],
              params.codecs,
            ),
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
    // サイマルキャスト利用時のRTXをサポートしていないのでcodecs/encodingsは常に一つ
    const [codec] = params.codecs;

    log("registerRtpReceiverByRid", param);
    transceiver.addTrack(
      new MediaStreamTrack({
        rid: param.rid,
        kind: transceiver.kind,
        id: transceiver.sender.trackId,
        remote: true,
        codec,
      }),
    );
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
   * The receiver of an RTP stream ID: by MID and RID when the packet carries
   * the MID extension, otherwise the first m-line that uses that RID.
   */
  private receiverByRid(rid: string, mid: unknown) {
    if (typeof mid === "string") {
      return this.ridTable[ridRouteKey(mid, rid)] as RTCRtpReceiver | undefined;
    }
    const key = Object.keys(this.ridTable).find(
      (candidate) => ridOfRouteKey(candidate) === rid,
    );
    return key ? (this.ridTable[key] as RTCRtpReceiver) : undefined;
  }

  routeRtp = (packet: RtpPacket) => {
    const extensions: Extensions = rtpHeaderExtensionsParser(
      packet.header.extensions,
      this.extIdUriMap,
    );

    let rtpReceiver: RTCRtpReceiver | undefined = this.ssrcTable[
      packet.header.ssrc
    ] as RTCRtpReceiver;

    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID];
    if (typeof rid === "string") {
      rtpReceiver = this.receiverByRid(
        rid,
        extensions[RTP_EXTENSION_URI.sdesMid],
      );
      if (!rtpReceiver) {
        log("rid receiver not found", rid);
        return;
      }
      rtpReceiver.latestRid = rid;
      rtpReceiver.handleRtpByRid(packet, rid, extensions);
    } else if (rtpReceiver) {
      rtpReceiver.handleRtpBySsrc(packet, extensions);
    } else {
      // simulcast after send receiver report
      rtpReceiver = Object.values(this.ridTable)
        .filter((r): r is RTCRtpReceiver => r instanceof RTCRtpReceiver)
        .find((r) => r.trackBySSRC[packet.header.ssrc]);
      if (rtpReceiver) {
        log("simulcast register receiver by ssrc", packet.header.ssrc);
        // Packet-driven, not a description: staged routes stay as they are.
        this.ssrcTable[packet.header.ssrc] = rtpReceiver;
        this.learnedSsrcs.add(packet.header.ssrc);
        rtpReceiver.handleRtpBySsrc(packet, extensions);
      } else {
        // bug
      }
    }

    if (!rtpReceiver) {
      log("ssrcReceiver not found");
      return;
    }

    const sdesMid = extensions[RTP_EXTENSION_URI.sdesMid];
    if (typeof sdesMid === "string") {
      rtpReceiver.sdesMid = sdesMid;
    }

    const repairedRid = extensions[
      RTP_EXTENSION_URI.repairedRtpStreamId
    ] as string;
    if (typeof repairedRid === "string") {
      rtpReceiver.latestRepairedRid = repairedRid;
    }
  };

  routeRtcp = (packet: RtcpPacket) => {
    const recipients: (RTCRtpReceiver | RTCRtpSender)[] = [];

    switch (packet.type) {
      case RtcpSrPacket.type:
        {
          packet = packet as RtcpSrPacket;
          recipients.push(this.ssrcTable[packet.ssrc]);
        }
        break;
      case RtcpRrPacket.type:
        {
          packet = packet as RtcpRrPacket;
          packet.reports.forEach((report) => {
            recipients.push(this.ssrcTable[report.ssrc]);
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
          if (rtpfb.feedback) {
            recipients.push(this.ssrcTable[rtpfb.feedback.mediaSourceSsrc]);
          }
        }
        break;
      case RtcpPayloadSpecificFeedback.type:
        {
          const psfb = packet as RtcpPayloadSpecificFeedback;
          switch (psfb.feedback.count) {
            case ReceiverEstimatedMaxBitrate.count:
              {
                const remb = psfb.feedback as ReceiverEstimatedMaxBitrate;
                recipients.push(this.ssrcTable[remb.ssrcFeedbacks[0]]);
              }
              break;
            default:
              recipients.push(
                this.ssrcTable[psfb.feedback.senderSsrc] ||
                  this.ssrcTable[psfb.feedback.mediaSsrc],
              );
          }
        }
        break;
    }
    recipients
      .filter((v) => v) // todo simulcast
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };
}
