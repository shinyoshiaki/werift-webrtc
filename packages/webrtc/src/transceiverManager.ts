import { ReceiverDirection, SenderDirections } from "./const";
import { createWebRtcDomException } from "./errors";
import { Event, debug } from "./imports/common";
import { RTP_EXTENSION_URI } from "./imports/rtp";
import {
  MediaStream,
  type MediaStreamTrack,
  type RTCRtpCodecParameters,
  RTCRtpCodingParameters,
  type RTCRtpEncodingParameters,
  type RTCRtpParameters,
  type RTCRtpReceiveParameters,
  RTCRtpReceiver,
  RTCRtpRtxParameters,
  RTCRtpSender,
  RTCRtpTransceiver,
  Recvonly,
  type RtpReceiverMediaSnapshot,
  type RtpRouter,
  type RtpSenderMediaSnapshot,
  Sendonly,
  Sendrecv,
  type TransceiverOptions,
} from "./media";
import type { RTCStats } from "./media/stats";
import {
  type PeerConfig,
  adoptSenderTrackCodec,
  findCodecByMimeType,
} from "./peerConnection";
import {
  type MediaDescription,
  type SessionDescription,
  codecParametersFromString,
} from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { Kind } from "./types/domain";
import { reverseDirection } from "./utils";

const log = debug("werift:packages/webrtc/src/media/rtpTransceiverManager.ts");

export interface TransceiverMediaSnapshot {
  transceiver: RTCRtpTransceiver;
  mid: string | null;
  mLineIndex: number | undefined;
  codecs: RTCRtpCodecParameters[];
  headerExtensions: RTCRtpTransceiver["headerExtensions"];
  rejected: boolean;
  direction: RTCRtpTransceiver["direction"];
  offerDirection: RTCRtpTransceiver["offerDirection"];
  currentDirection: RTCRtpTransceiver["currentDirection"];
  usedForSender: boolean;
  receiver: RtpReceiverMediaSnapshot;
  sender: RtpSenderMediaSnapshot;
  dtlsTransport?: RTCDtlsTransport;
}

export interface RouterTableSnapshot {
  ssrcTable: RtpRouter["ssrcTable"];
  ridTable: RtpRouter["ridTable"];
  midTable: RtpRouter["midTable"];
  extIdUriMap: RtpRouter["extIdUriMap"];
}

function simulcastFromSendEncodings(
  encodings: RTCRtpEncodingParameters[] | undefined,
): TransceiverOptions["simulcast"] | undefined {
  if (!encodings || encodings.length < 2) {
    return undefined;
  }
  const rids = encodings
    .map((encoding) => encoding.rid)
    .filter((rid): rid is string => typeof rid === "string" && rid.length > 0);
  if (rids.length < 2) {
    return undefined;
  }
  return rids.map((rid) => ({ rid, direction: "send" as const }));
}

export class TransceiverManager {
  private readonly transceivers: RTCRtpTransceiver[] = [];

  readonly onTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onRemoteTransceiverAdded = new Event<[RTCRtpTransceiver]>();
  readonly onTrack = new Event<
    [
      {
        track: MediaStreamTrack;
        transceiver: RTCRtpTransceiver;
        streams: MediaStream[];
      },
    ]
  >();
  readonly onNegotiationNeeded = new Event<[]>();
  /**
   * finalize 中 (確定済み rejection の terminal stop など) は、新しい交渉を
   * 要求する必要がないため negotiationneeded の再発火を抑える。
   */
  private finalizeSuppressed = 0;

  /**
   * 内部確定処理を negotiationneeded なしで実行する。protocol-driven な
   * rejection 適用 (remote SDP 由来の stop/finalize) では、新しい local
   * negotiation を要求しない。application の明示的 stop とは別経路にする。
   */
  runWithoutNegotiationNeeded<T>(fn: () => T): T {
    this.finalizeSuppressed++;
    try {
      return fn();
    } finally {
      this.finalizeSuppressed--;
    }
  }

  constructor(
    private readonly cname: string,
    private readonly config: Required<PeerConfig>,
    private readonly router: RtpRouter,
  ) {}

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  getSenders(): RTCRtpSender[] {
    return this.getTransceivers().map((t) => t.sender);
  }

  getReceivers() {
    return this.getTransceivers().map((t) => t.receiver);
  }

  getTransceiverByMLineIndex(index: number): RTCRtpTransceiver | undefined {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index,
    );
  }

  pushTransceiver(t: RTCRtpTransceiver): void {
    this.transceivers.push(t);
  }

  replaceTransceiver(t: RTCRtpTransceiver, index: number): void {
    this.transceivers[index] = t;
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    dtlsTransport?: RTCDtlsTransport,
    options: Partial<TransceiverOptions> = {},
  ): RTCRtpTransceiver {
    const kind =
      typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind;

    const direction = options.direction || "sendrecv";

    const sender = new RTCRtpSender(trackOrKind, {
      pendingRtp: this.config.pendingRtp,
    });
    const receiver = new RTCRtpReceiver(this.config, kind, sender.ssrc);
    const newTransceiver = new RTCRtpTransceiver(
      kind,
      dtlsTransport,
      receiver,
      sender,
      direction,
    );
    newTransceiver.options = {
      ...options,
      simulcast:
        options.simulcast ?? simulcastFromSendEncodings(options.sendEncodings),
    };
    newTransceiver.sender.setStreams(options.streams ?? []);
    newTransceiver.sender.setSendEncodings(
      (
        (options.sendEncodings as RTCRtpEncodingParameters[] | undefined) ?? []
      ).map((encoding) => ({ ...encoding })),
    );
    this.router.registerRtpSender(newTransceiver.sender);
    newTransceiver.onStopping.subscribe(() => {
      this.clearRejectedRtpPipeline(newTransceiver);
      this.router.unregisterRtpSender(newTransceiver.sender);
      if (this.finalizeSuppressed === 0) {
        this.onNegotiationNeeded.execute();
      }
    });
    // New transceivers get an available, negotiated port-zero slot at offer
    // generation time. Never steal an associated inactive transceiver's MID.
    this.pushTransceiver(newTransceiver);
    this.onTransceiverAdded.execute(newTransceiver);

    return newTransceiver;
  }

  addTrack(
    track: MediaStreamTrack,
    streams: MediaStream[] = [],
  ): RTCRtpTransceiver {
    if (this.getSenders().find((sender) => sender.track?.uuid === track.uuid)) {
      throw createWebRtcDomException(
        "InvalidAccessError",
        "Track already added",
      );
    }

    const emptyTrackSenderTransceiver = this.transceivers.find(
      (t) =>
        !t.rejected &&
        !t.stopping &&
        !t.sender.stopped &&
        !t.usedForSender &&
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === true,
    );
    if (emptyTrackSenderTransceiver) {
      const sender = emptyTrackSenderTransceiver.sender;
      sender.setStreams(streams);
      sender.registerTrack(track);
      emptyTrackSenderTransceiver.options = {
        ...emptyTrackSenderTransceiver.options,
        streams,
      };
      return emptyTrackSenderTransceiver;
    }

    const notSendTransceiver = this.transceivers.find(
      (t) =>
        !t.rejected &&
        !t.stopping &&
        !t.sender.stopped &&
        t.sender.track == undefined &&
        t.kind === track.kind &&
        SenderDirections.includes(t.direction) === false &&
        !t.usedForSender,
    );
    if (notSendTransceiver) {
      const sender = notSendTransceiver.sender;
      sender.setStreams(streams);
      sender.registerTrack(track);
      notSendTransceiver.options = {
        ...notSendTransceiver.options,
        streams,
      };
      switch (notSendTransceiver.direction) {
        case "recvonly":
          notSendTransceiver.setDirection("sendrecv");
          break;
        case "inactive":
          notSendTransceiver.setDirection("sendonly");
          break;
      }
      return notSendTransceiver;
    } else {
      const transceiver = this.addTransceiver(track, undefined, {
        direction: "sendrecv",
        streams,
      });
      return transceiver;
    }
  }

  removeTrack(sender: RTCRtpSender): void {
    if (!this.getSenders().find(({ ssrc }) => sender.ssrc === ssrc)) {
      throw createWebRtcDomException(
        "InvalidAccessError",
        "Sender does not exist",
      );
    }

    const transceiver = this.transceivers.find(
      ({ sender: { ssrc } }) => sender.ssrc === ssrc,
    );
    if (!transceiver) throw new Error("No matching transceiver found");

    if (transceiver.stopping || transceiver.stopped) {
      return;
    }

    // removeTrack は track の detach であり terminal stop ではない。同じ
    // sender への replaceTrack + direction 復帰で同じ MID/m-line を再開できる
    // よう、stopped フラグは立てない。terminal な停止は transceiver.stop() 側
    // の sender.stop() に限定する。
    void sender.replaceTrack(null);

    if (["recvonly", "inactive"].includes(transceiver.currentDirection ?? "")) {
      this.onNegotiationNeeded.execute();
      return;
    }

    if (transceiver.direction === "sendrecv") {
      transceiver.setDirection("recvonly");
    } else if (
      transceiver.direction === "sendonly" ||
      transceiver.direction === "recvonly"
    ) {
      transceiver.setDirection("inactive");
    }
  }

  assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void {
    adoptSenderTrackCodec(this.config, transceiver.sender.track);
    const codecs = (
      this.config.codecs[transceiver.kind] as RTCRtpCodecParameters[]
    ).filter((codecCandidate) => {
      switch (codecCandidate.direction) {
        case "recvonly": {
          if (ReceiverDirection.includes(transceiver.direction)) return true;
          return false;
        }
        case "sendonly": {
          if (SenderDirections.includes(transceiver.direction)) return true;
          return false;
        }
        case "sendrecv": {
          if ([Sendrecv, Recvonly, Sendonly].includes(transceiver.direction))
            return true;
          return false;
        }
        case "all": {
          return true;
        }
        default:
          return false;
      }
    });
    transceiver.codecs = codecs;
  }

  getLocalRtpParams(transceiver: RTCRtpTransceiver): RTCRtpParameters {
    if (transceiver.mid == undefined) throw new Error("mid not assigned");

    const rtp: RTCRtpParameters = {
      codecs: transceiver.codecs,
      muxId: transceiver.mid,
      headerExtensions: transceiver.headerExtensions,
      rtcp: { cname: this.cname, ssrc: transceiver.sender.ssrc, mux: true },
    };
    return rtp;
  }

  getRemoteRtpParams(
    media: MediaDescription,
    transceiver: RTCRtpTransceiver,
  ): RTCRtpReceiveParameters {
    const receiveParameters: RTCRtpReceiveParameters = {
      muxId: media.rtp.muxId,
      rtcp: media.rtp.rtcp,
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      encodings: Object.values(
        transceiver.codecs.reduce(
          (acc: { [pt: number]: RTCRtpCodingParameters }, codec) => {
            if (codec.name.toLowerCase() === "rtx") {
              const params = codecParametersFromString(codec.parameters ?? "");
              const apt = acc[params["apt"]];
              if (apt && media.ssrc.length === 2) {
                apt.rtx = new RTCRtpRtxParameters({ ssrc: media.ssrc[1].ssrc });
              }
              return acc;
            }
            acc[codec.payloadType] = new RTCRtpCodingParameters({
              ssrc: media.ssrc[0]?.ssrc,
              payloadType: codec.payloadType,
            });
            return acc;
          },
          {},
        ),
      ),
    };

    return receiveParameters;
  }

  /**
   * remote answer/pranswer の commit 前検証。non-zero の audio/video m-line は
   * pending local offer と共通 codec が必要。offer 側の「unsupported は answer
   * で reject」を answer 側に広げず、無効な answer は状態変更前に失敗させる。
   * remote port 0 は通常どおり受理する。
   */
  validateAnswerCodecs(
    remoteSdp: SessionDescription,
    localOffer: SessionDescription | undefined,
  ): void {
    remoteSdp.media.forEach((remoteMedia, index) => {
      if (!["audio", "video"].includes(remoteMedia.kind)) {
        return;
      }
      if (remoteMedia.port === 0) {
        return;
      }
      const localMedia =
        localOffer?.media[index] ??
        localOffer?.media.find(
          (media) => media.rtp.muxId === remoteMedia.rtp.muxId,
        );
      const localCodecs =
        localMedia && ["audio", "video"].includes(localMedia.kind)
          ? localMedia.rtp.codecs
          : (this.config.codecs[remoteMedia.kind] ?? []);
      const common = remoteMedia.rtp.codecs.filter((remoteCodec) =>
        findCodecByMimeType(localCodecs, remoteCodec),
      );
      if (common.length === 0) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `answer m-line ${index} has no common codec with the local offer.`,
        );
      }
    });
  }

  /**
   * remote offer/pranswer 適用前の transceiver media 状態の snapshot。
   * rollback 時に復元し、pending だった codec/rejection/direction 変更を
   * current session へ漏らさないようにする。
   */
  snapshotTransceiverMedia(): TransceiverMediaSnapshot[] {
    return this.transceivers.map((transceiver) => ({
      transceiver,
      mid: transceiver.mid,
      mLineIndex: transceiver.mLineIndex,
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      rejected: transceiver.rejected,
      direction: transceiver.direction,
      offerDirection: transceiver.offerDirection,
      currentDirection: transceiver.currentDirection,
      usedForSender: transceiver.usedForSender,
      receiver: transceiver.receiver.snapshotMediaState(),
      sender: transceiver.sender.snapshotMediaState(),
      dtlsTransport: transceiver.dtlsTransport,
    }));
  }

  restoreTransceiverMedia(snapshot: TransceiverMediaSnapshot[]): void {
    // rollback 後に追加された transceiver は明示的に停止してから取り除く。
    // sender/receiver・router 登録の後始末を伴う。交換自体で確定したわけでは
    // ないため negotiationneeded は発火させない。
    const added = this.transceivers.filter(
      (transceiver) =>
        !snapshot.some((entry) => entry.transceiver === transceiver),
    );
    this.runWithoutNegotiationNeeded(() => {
      for (const transceiver of added) {
        transceiver.stop();
      }
    });
    for (let i = this.transceivers.length - 1; i >= 0; i--) {
      if (
        !snapshot.some((entry) => entry.transceiver === this.transceivers[i])
      ) {
        this.transceivers.splice(i, 1);
      }
    }
    for (const entry of snapshot) {
      if (!this.transceivers.includes(entry.transceiver)) {
        continue;
      }
      const transceiver = entry.transceiver;
      transceiver.mid = entry.mid;
      transceiver.mLineIndex = entry.mLineIndex;
      transceiver.codecs = entry.codecs;
      transceiver.headerExtensions = entry.headerExtensions;
      transceiver.rejected = entry.rejected;
      transceiver.setDirection(entry.direction);
      transceiver.offerDirection = entry.offerDirection;
      transceiver.setCurrentDirection(entry.currentDirection ?? undefined);
      // setDirection/setCurrentDirection の副作用を snapshot 値で上書きする。
      transceiver.usedForSender = entry.usedForSender;
      transceiver.receiver.restoreMediaState(entry.receiver);
      transceiver.sender.restoreMediaState(entry.sender);
      if (
        entry.dtlsTransport &&
        transceiver.dtlsTransport !== entry.dtlsTransport
      ) {
        transceiver.setDtlsTransport(entry.dtlsTransport);
      }
    }
  }

  snapshotRouterTables(): RouterTableSnapshot {
    return {
      ssrcTable: { ...this.router.ssrcTable },
      ridTable: { ...this.router.ridTable },
      midTable: { ...this.router.midTable },
      extIdUriMap: { ...this.router.extIdUriMap },
    };
  }

  restoreRouterTables(snapshot: RouterTableSnapshot): void {
    for (const key of Object.keys(this.router.ssrcTable)) {
      delete this.router.ssrcTable[Number(key)];
    }
    Object.assign(this.router.ssrcTable, snapshot.ssrcTable);
    for (const key of Object.keys(this.router.ridTable)) {
      delete this.router.ridTable[key];
    }
    Object.assign(this.router.ridTable, snapshot.ridTable);
    for (const key of Object.keys(this.router.midTable)) {
      delete this.router.midTable[key];
    }
    Object.assign(this.router.midTable, snapshot.midTable);
    for (const key of Object.keys(this.router.extIdUriMap)) {
      delete this.router.extIdUriMap[Number(key)];
    }
    Object.assign(this.router.extIdUriMap, snapshot.extIdUriMap);
  }

  setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer" | "pranswer",
    mLineIndex: number,
  ): void {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId ?? null;
    }
    transceiver.mLineIndex = mLineIndex;

    adoptSenderTrackCodec(this.config, transceiver.sender.track);

    // # negotiate codecs
    transceiver.codecs = remoteMedia.rtp.codecs.filter((remoteCodec) => {
      const localCodecs = this.config.codecs[remoteMedia.kind] || [];

      const existCodec = findCodecByMimeType(localCodecs, remoteCodec);
      if (!existCodec) {
        return false;
      }

      if (existCodec?.name.toLowerCase() === "rtx") {
        const params = codecParametersFromString(existCodec.parameters ?? "");
        const pt = params["apt"];
        const origin = remoteMedia.rtp.codecs.find((c) => c.payloadType === pt);
        if (!origin) {
          return false;
        }
        return !!findCodecByMimeType(localCodecs, origin);
      }

      return true;
    });

    log("negotiated codecs", transceiver.codecs);
    transceiver.rejected =
      transceiver.stopped ||
      transceiver.codecs.length === 0 ||
      remoteMedia.port === 0;

    if (
      (type === "answer" || type === "pranswer") &&
      remoteMedia.port !== 0 &&
      transceiver.codecs.length === 0
    ) {
      // offerer は answer で m-line を拒否できない。non-zero answer/pranswer
      // の codec 不一致は無効な answer として失敗させる。通常は
      // validateAnswerCodecs の事前検証で弾くため、ここは防御的な二重化。
      throw createWebRtcDomException(
        "InvalidAccessError",
        "answered codecs are not compatible with the local offer.",
      );
    }

    // # configure direction
    const mediaDirection = remoteMedia.direction ?? "inactive";
    const direction = reverseDirection(mediaDirection);
    if (["answer", "pranswer"].includes(type)) {
      if (!transceiver.stopped) transceiver.setCurrentDirection(direction);
    } else {
      transceiver.offerDirection = direction;
    }

    if (type === "answer") {
      // remote final answer は確定なので terminal stop を即時実行してよい。
      if (remoteMedia.port === 0) {
        transceiver.stop();
      }
      if (transceiver.rejected || transceiver.stopping) {
        this.clearRejectedRtpPipeline(transceiver);
        return;
      }
    } else if (transceiver.rejected || transceiver.stopping) {
      // offer/pranswer は pending 扱い: local/remote answer の commit までは
      // current pipeline と terminal 状態を変更せず、rollback で復元できる
      // ようにする。確定は answer 適用時 (finishMediaStops) に行う。
      if (transceiver.sender.codec === undefined) {
        this.clearRejectedRtpPipeline(transceiver);
      }
      return;
    }

    const localHeaderExtensions =
      this.config.headerExtensions[remoteMedia.kind as "audio" | "video"] || [];
    transceiver.headerExtensions = remoteMedia.rtp.headerExtensions.filter(
      (extension) =>
        localHeaderExtensions.some((local) => local.uri === extension.uri) ||
        extension.uri === RTP_EXTENSION_URI.sdesMid ||
        extension.uri === RTP_EXTENSION_URI.sdesRTPStreamID ||
        extension.uri === RTP_EXTENSION_URI.repairedRtpStreamId,
    );

    const localParams = this.getLocalRtpParams(transceiver);
    transceiver.sender.prepareSend(localParams);

    // 再交渉で track が増えたときだけ ontrack する。同一 track のままでは
    // アプリへ重複通知しない。
    const tracksBefore = transceiver.receiver.tracks.length;

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remotePrams = this.getRemoteRtpParams(remoteMedia, transceiver);

      // register simulcast receiver
      for (const param of remoteMedia.simulcastParameters) {
        this.router.registerRtpReceiverByRid(transceiver, param, remotePrams);
      }

      transceiver.receiver.prepareReceive(remotePrams);
      // register ssrc receiver
      this.router.registerRtpReceiverBySsrc(transceiver, remotePrams);
    }
    if (
      remoteMedia.port !== 0 &&
      ["sendonly", "sendrecv"].includes(mediaDirection) &&
      transceiver.receiver.tracks.length > tracksBefore
    ) {
      const remoteStreamIds = [
        ...new Set(remoteMedia.msids.map((msid) => msid.split(" ")[0])),
      ];
      const remoteTrackId = remoteMedia.msids[0]?.split(" ")[1];
      transceiver.receiver.remoteStreamId = remoteStreamIds[0];
      transceiver.receiver.remoteStreamIds = remoteStreamIds;
      transceiver.receiver.remoteTrackId = remoteTrackId;

      this.onTrack.execute({
        track: transceiver.receiver.track,
        transceiver,
        streams: remoteStreamIds.map(
          (id) =>
            new MediaStream({
              id,
              tracks: [transceiver.receiver.track],
            }),
        ),
      });
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
  }

  private clearRejectedRtpPipeline(transceiver: RTCRtpTransceiver) {
    this.router.unregisterRtpReceiver(transceiver);
    transceiver.sender.clearSend();
    transceiver.receiver.clearReceive();
    transceiver.headerExtensions = [];
  }

  collectStats(timestamp: number): RTCStats[] {
    const stats: RTCStats[] = [];

    for (const transceiver of this.transceivers) {
      if (transceiver.sender) {
        stats.push(...transceiver.sender.collectStats(timestamp));
      }

      if (transceiver.receiver) {
        stats.push(...transceiver.receiver.collectStats(timestamp));
      }

      const codecStats = transceiver.collectCodecStats(timestamp);
      if (codecStats) {
        stats.push(...codecStats);
      }
    }

    return stats;
  }

  getStatsRootIds(selector: MediaStreamTrack | null | undefined) {
    if (!selector) {
      return [];
    }

    const rootIds: string[] = [];
    for (const transceiver of this.transceivers) {
      if (transceiver.sender.track === selector) {
        rootIds.push(...transceiver.sender.getStatsRootIds());
      }
      if (transceiver.receiver.tracks.includes(selector)) {
        rootIds.push(...transceiver.receiver.getStatsRootIds(selector));
      }
    }

    return rootIds;
  }

  /**
   * 全トランシーバーのreceiver/senderのstopを呼ぶcloseメソッド
   */
  close() {
    for (const transceiver of this.transceivers) {
      transceiver.forceStop();
    }

    this.onTransceiverAdded.allUnsubscribe();
    this.onRemoteTransceiverAdded.allUnsubscribe();
    this.onTrack.allUnsubscribe();
    this.onNegotiationNeeded.allUnsubscribe();
  }
}
