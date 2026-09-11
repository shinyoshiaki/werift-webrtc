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
import type {
  RTCRtpReceiveParameters,
  RTCRtpSimulcastParameters,
} from "./parameters";
import { RTCRtpReceiver } from "./rtpReceiver";
import type { RTCRtpSender } from "./rtpSender";
import type { RTCRtpTransceiver } from "./rtpTransceiver";

const log = debug("werift:packages/webrtc/src/media/router.ts");

type RtpSessionTables = {
  ssrcTable: { [ssrc: number]: RTCRtpReceiver | RTCRtpSender };
  ridTable: { [rid: string]: RTCRtpReceiver | RTCRtpSender };
  extIdUriMap: { [id: number]: string };
};

export class RtpRouter {
  private sessions: { [transportId: string]: RtpSessionTables } = {};

  constructor() {}

  /** Merged view for single-session callers; per-transport maps are authoritative. */
  get extIdUriMap() {
    return this.mergeMaps((session) => session.extIdUriMap);
  }

  get ssrcTable() {
    return this.mergeMaps((session) => session.ssrcTable);
  }

  get ridTable() {
    return this.mergeMaps((session) => session.ridTable);
  }

  snapshotRtpSessions() {
    return Object.fromEntries(
      Object.entries(this.sessions).map(([id, session]) => [
        id,
        {
          ssrcTable: { ...session.ssrcTable },
          ridTable: { ...session.ridTable },
          extIdUriMap: { ...session.extIdUriMap },
        },
      ]),
    );
  }

  restoreRtpSessions(sessions: {
    [transportId: string]: RtpSessionTables;
  }) {
    this.sessions = Object.fromEntries(
      Object.entries(sessions).map(([id, session]) => [
        id,
        {
          ssrcTable: { ...session.ssrcTable },
          ridTable: { ...session.ridTable },
          extIdUriMap: { ...session.extIdUriMap },
        },
      ]),
    );
  }

  snapshotExtIdUriMaps() {
    return Object.fromEntries(
      Object.entries(this.sessions).map(([id, session]) => [
        id,
        { ...session.extIdUriMap },
      ]),
    );
  }

  restoreExtIdUriMaps(maps: {
    [transportId: string]: { [id: number]: string };
  }) {
    for (const [id, map] of Object.entries(maps)) {
      this.session(id).extIdUriMap = { ...map };
    }
    for (const id of Object.keys(this.sessions)) {
      if (!(id in maps)) {
        this.session(id).extIdUriMap = {};
      }
    }
  }

  registerRtpSender(sender: RTCRtpSender) {
    this.unregisterEndpoint(sender);
    this.session(this.sessionIdForSender(sender)).ssrcTable[sender.ssrc] =
      sender;
  }

  private registerRtpReceiver(
    receiver: RTCRtpReceiver,
    ssrc: number,
    sessionId: string,
  ) {
    log("registerRtpReceiver", ssrc);
    this.session(sessionId).ssrcTable[ssrc] = receiver;
  }

  registerRtpReceiverBySsrc(
    transceiver: RTCRtpTransceiver,
    params: RTCRtpReceiveParameters,
  ) {
    log("registerRtpReceiverBySsrc", params);
    const sessionId = this.sessionIdFor(transceiver);
    this.unregisterEndpoint(transceiver.receiver);

    params.encodings
      .filter((e) => e.ssrc != undefined) // todo fix
      .forEach((encode, i) => {
        this.registerRtpReceiver(transceiver.receiver, encode.ssrc, sessionId);
        transceiver.addTrack(transceiver.receiver.track);
        transceiver.receiver.bindRemoteSsrc(encode.ssrc, params.codecs[i]);
        if (encode.rtx) {
          this.registerRtpReceiver(
            transceiver.receiver,
            encode.rtx.ssrc,
            sessionId,
          );
          transceiver.receiver.bindRemoteSsrc(
            encode.rtx.ssrc,
            params.codecs[i],
          );
        }
      });

    this.installHeaderExtensions(sessionId, params.headerExtensions);
  }

  /** @internal */
  assertExtmapIdsNotRemapped(
    sessionId: string,
    headerExtensions: Array<{ id: number; uri: string }>,
  ) {
    const currentMap = this.session(sessionId).extIdUriMap;
    for (const extension of headerExtensions) {
      const current = currentMap[extension.id];
      if (current && current !== extension.uri) {
        throw new Error(
          `extmap id ${extension.id} remapped from ${current} to ${extension.uri}`,
        );
      }
    }
  }

  private installHeaderExtensions(
    sessionId: string,
    headerExtensions: Array<{ id: number; uri: string }>,
  ) {
    const currentMap = this.session(sessionId).extIdUriMap;
    for (const extension of headerExtensions) {
      currentMap[extension.id] = extension.uri;
    }
  }

  /** @internal */
  unregisterRtpReceiver(receiver: RTCRtpReceiver) {
    this.unregisterEndpoint(receiver);
  }

  registerRtpReceiverByRid(
    transceiver: RTCRtpTransceiver,
    param: RTCRtpSimulcastParameters,
    params: RTCRtpReceiveParameters,
  ) {
    // サイマルキャスト利用時のRTXをサポートしていないのでcodecs/encodingsは常に一つ
    const [codec] = params.codecs;

    log("registerRtpReceiverByRid", param);
    this.unregisterEndpoint(transceiver.receiver);
    transceiver.addTrack(transceiver.receiver.track);
    transceiver.receiver.bindRemoteRid(param.rid, codec);
    this.session(this.sessionIdFor(transceiver)).ridTable[param.rid] =
      transceiver.receiver;
  }

  routeRtp = (packet: RtpPacket, transportId?: string) => {
    const session = transportId
      ? this.sessions[transportId]
      : this.singleSession();
    const extensions: Extensions = rtpHeaderExtensionsParser(
      packet.header.extensions,
      session?.extIdUriMap ?? this.extIdUriMap,
    );

    let rtpReceiver: RTCRtpReceiver | undefined = session?.ssrcTable[
      packet.header.ssrc
    ] as RTCRtpReceiver;

    const rid = extensions[RTP_EXTENSION_URI.sdesRTPStreamID];
    if (typeof rid === "string") {
      rtpReceiver = session?.ridTable[rid] as RTCRtpReceiver | undefined;
      if (!rtpReceiver) {
        log("unknown rid", rid);
        return;
      }
      rtpReceiver.latestRid = rid;
      rtpReceiver.handleRtpByRid(packet, rid, extensions);
    } else if (rtpReceiver) {
      rtpReceiver.handleRtpBySsrc(packet, extensions);
    } else {
      // simulcast after send receiver report
      rtpReceiver = Object.values(session?.ridTable ?? {})
        .filter((r): r is RTCRtpReceiver => r instanceof RTCRtpReceiver)
        .find((r) => r.trackBySSRC[packet.header.ssrc]);
      if (rtpReceiver && session) {
        log("simulcast register receiver by ssrc", packet.header.ssrc);
        this.registerRtpReceiver(
          rtpReceiver,
          packet.header.ssrc,
          transportId ?? this.sessionIdForReceiver(rtpReceiver),
        );
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

  routeRtcp = (packet: RtcpPacket, transportId?: string) => {
    const ssrcTable =
      (transportId && this.sessions[transportId]?.ssrcTable) || this.ssrcTable;
    const recipients: (RTCRtpReceiver | RTCRtpSender)[] = [];

    switch (packet.type) {
      case RtcpSrPacket.type:
        {
          packet = packet as RtcpSrPacket;
          recipients.push(ssrcTable[packet.ssrc]);
        }
        break;
      case RtcpRrPacket.type:
        {
          packet = packet as RtcpRrPacket;
          packet.reports.forEach((report) => {
            recipients.push(ssrcTable[report.ssrc]);
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
            recipients.push(ssrcTable[rtpfb.feedback.mediaSourceSsrc]);
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
                recipients.push(ssrcTable[remb.ssrcFeedbacks[0]]);
              }
              break;
            default:
              recipients.push(
                ssrcTable[psfb.feedback.senderSsrc] ||
                  ssrcTable[psfb.feedback.mediaSsrc],
              );
          }
        }
        break;
    }
    recipients
      .filter((v) => v) // todo simulcast
      .forEach((recipient) => recipient.handleRtcpPacket(packet));
  };

  private session(id: string): RtpSessionTables {
    return (this.sessions[id] ??= {
      ssrcTable: {},
      ridTable: {},
      extIdUriMap: {},
    });
  }

  private sessionIdFor(transceiver: RTCRtpTransceiver) {
    return transceiver.dtlsTransport?.id ?? "";
  }

  private sessionIdForSender(sender: RTCRtpSender) {
    return sender.dtlsTransport?.id ?? "";
  }

  private sessionIdForReceiver(receiver: RTCRtpReceiver) {
    return receiver.dtlsTransport?.id ?? "";
  }

  private singleSession() {
    const sessions = Object.values(this.sessions);
    return sessions.length === 1 ? sessions[0] : undefined;
  }

  private mergeMaps<T>(
    pick: (session: RtpSessionTables) => { [key: string | number]: T },
  ) {
    const maps = Object.values(this.sessions).map(pick);
    if (maps.length === 0) {
      return {};
    }
    if (maps.length === 1) {
      return maps[0]!;
    }
    return Object.assign({}, ...maps) as { [key: string | number]: T };
  }

  private unregisterEndpoint(endpoint: RTCRtpReceiver | RTCRtpSender) {
    for (const session of Object.values(this.sessions)) {
      for (const ssrc of Object.keys(session.ssrcTable)) {
        if (session.ssrcTable[Number(ssrc)] === endpoint) {
          delete session.ssrcTable[Number(ssrc)];
        }
      }
      for (const rid of Object.keys(session.ridTable)) {
        if (session.ridTable[rid] === endpoint) {
          delete session.ridTable[rid];
        }
      }
    }
  }
}
