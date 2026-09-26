import { ReceiverDirection, SenderDirections } from "./const";
import { createWebRtcDomException } from "./errors";
import { Event, debug } from "./imports/common";
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
  type RtpRouter,
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
import { type MediaDescription, codecParametersFromString } from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { Kind } from "./types/domain";
import { reverseDirection } from "./utils";

const log = debug("werift:packages/webrtc/src/media/rtpTransceiverManager.ts");

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
  private readonly watched = new WeakSet<RTCRtpTransceiver>();
  private remoteOfferSnapshot?: {
    transceivers: RTCRtpTransceiver[];
    states: Map<
      RTCRtpTransceiver,
      {
        mid: string | null;
        mLineIndex?: number;
        pendingRejection: boolean;
        firedReceiving: boolean;
      }
    >;
  };

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
    this.watchTransceiver(t);
    this.transceivers.push(t);
  }

  replaceTransceiver(t: RTCRtpTransceiver, index: number): void {
    this.watchTransceiver(t);
    this.transceivers[index] = t;
  }

  /**m-line から外れた transceiver の購読を解除する */
  private unwatchTransceiver(t: RTCRtpTransceiver) {
    this.watched.delete(t);
    t.onRelease.allUnsubscribe();
    t.onStopRequested.allUnsubscribe();
  }

  private watchTransceiver(t: RTCRtpTransceiver) {
    if (this.watched.has(t)) {
      return;
    }
    this.watched.add(t);
    t.onRelease.subscribe(() => {
      this.router.unregisterTransceiver(t);
    });
    t.onStopRequested.subscribe(() => {
      // 未関連付けの stop は m-line を作らないので交渉不要
      if (!t.stopped) {
        this.onNegotiationNeeded.execute();
      }
    });
  }

  /**
   * 拒否 / 停止の交渉が確定した port 0 の位置のうち、同じ kind で
   * まだ他の transceiver が予約していないものを返す。
   * stopping (未交渉) の位置は先取りしない。
   */
  private findReusableTransceiver(kind: Kind) {
    return this.transceivers.find(
      (t) =>
        t.stopped &&
        t.kind === kind &&
        t.mLineIndex != undefined &&
        !this.transceivers.some(
          (other) => other !== t && other.mLineIndex === t.mLineIndex,
        ),
    );
  }

  /**旧 transceiver を m-line から外し、同じ位置に新しい transceiver を置く */
  private takeOverMLine(
    oldTransceiver: RTCRtpTransceiver,
    newTransceiver: RTCRtpTransceiver,
  ) {
    const index = this.transceivers.indexOf(oldTransceiver);
    newTransceiver.mLineIndex = oldTransceiver.mLineIndex;
    oldTransceiver.mid = null;
    oldTransceiver.mLineIndex = undefined;
    this.unwatchTransceiver(oldTransceiver);
    this.replaceTransceiver(newTransceiver, index);
  }

  addTransceiver(
    trackOrKind: Kind | MediaStreamTrack,
    dtlsTransport?: RTCDtlsTransport,
    options: Partial<TransceiverOptions> = {},
    {
      remoteMLineIndex,
    }: {
      /**remote offer 起因で作る場合の m-line index。確定済み停止位置の自動再利用は行わない */
      remoteMLineIndex?: number;
    } = {},
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

    // 旧 transceiver は復活させず、MID は次の offer で新しく割り当てる
    const reusable =
      remoteMLineIndex == undefined
        ? this.findReusableTransceiver(kind)
        : this.transceivers.find(
            (t) => t.stopped && t.mLineIndex === remoteMLineIndex,
          );
    if (reusable) {
      this.takeOverMLine(reusable, newTransceiver);
    } else {
      this.pushTransceiver(newTransceiver);
    }
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

    const reusableForTrack = (t: RTCRtpTransceiver) =>
      t.sender.track == undefined &&
      t.kind === track.kind &&
      !t.usedForSender &&
      !t.stopping &&
      !t.stopped &&
      !t.rejected &&
      !t.pendingRejection;

    const emptyTrackSenderTransceiver = this.transceivers.find(
      (t) => reusableForTrack(t) && SenderDirections.includes(t.direction),
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
      (t) => reusableForTrack(t) && !SenderDirections.includes(t.direction),
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

    if (sender.track == undefined) {
      return;
    }

    // sender 自体は止めず track だけ外し、同じ sender で送信を再開できるようにする
    sender.detachTrack();

    if (transceiver.direction === "sendrecv") {
      transceiver.setDirection("recvonly");
    } else if (transceiver.direction === "sendonly") {
      transceiver.setDirection("inactive");
    }
    this.onNegotiationNeeded.execute();
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

  /**remote m-line の codec と local 設定の共通部分を返す */
  negotiateCodecs(remoteMedia: MediaDescription): RTCRtpCodecParameters[] {
    const localCodecs = this.config.codecs[remoteMedia.kind] || [];
    return remoteMedia.rtp.codecs.filter((remoteCodec) => {
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
  }

  /**
   * remote m-line を transceiver に適用する。
   * 共通 codec がない、または remote port 0 の m-line は拒否として扱い、
   * sender/receiver 準備・router 登録・onTrack・TWCC を行わない。
   * @returns 受け入れた (RTP を流す) 場合 true
   */
  setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer" | "pranswer",
    mLineIndex: number,
  ): boolean {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId ?? null;
    }
    transceiver.mLineIndex = mLineIndex;

    if (transceiver.stopped) {
      // 確定済みの停止 / 拒否 m-line は復活させない
      return false;
    }

    if (transceiver.stopping) {
      // app の stop() は自分の offer で交渉する。port 0 の answer で停止を確定する
      if (type === "answer" && remoteMedia.port === 0) {
        transceiver.commitStopped({ rejected: false });
      }
      return false;
    }

    adoptSenderTrackCodec(this.config, transceiver.sender.track);

    // # negotiate codecs
    const codecs = this.negotiateCodecs(remoteMedia);
    log("negotiated codecs", codecs);

    if (remoteMedia.port === 0 || codecs.length === 0) {
      if (type === "answer") {
        transceiver.commitStopped({ rejected: true });
      } else {
        // answer が確定するまで既存の RTP pipeline / track は維持する
        transceiver.pendingRejection = true;
      }
      return false;
    }
    transceiver.pendingRejection = false;

    transceiver.codecs = codecs;
    transceiver.headerExtensions = remoteMedia.rtp.headerExtensions.filter(
      (extension) =>
        (
          this.config.headerExtensions[remoteMedia.kind as "audio" | "video"] ||
          []
        ).find((v) => v.uri === extension.uri),
    );

    // # configure direction
    const mediaDirection = remoteMedia.direction ?? "inactive";
    const direction = reverseDirection(mediaDirection);
    if (["answer", "pranswer"].includes(type)) {
      transceiver.setCurrentDirection(direction);
    } else {
      transceiver.offerDirection = direction;
    }
    const localParams = this.getLocalRtpParams(transceiver);
    transceiver.sender.prepareSend(localParams);

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
    if (["sendonly", "sendrecv"].includes(mediaDirection)) {
      const remoteStreamIds = [
        ...new Set(remoteMedia.msids.map((msid) => msid.split(" ")[0])),
      ];
      const remoteTrackId = remoteMedia.msids[0]?.split(" ")[1];
      transceiver.receiver.remoteStreamId = remoteStreamIds[0];
      transceiver.receiver.remoteStreamIds = remoteStreamIds;
      transceiver.receiver.remoteTrackId = remoteTrackId;

      // re-offer / re-answer で同じ受信を重複通知しない
      if (!transceiver.firedReceiving) {
        transceiver.firedReceiving = true;
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
    } else {
      transceiver.firedReceiving = false;
    }

    if (remoteMedia.ssrc[0]?.ssrc) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
    return true;
  }

  /**
   * remote offer 適用前の transceiver 対応を保存する。
   * 同じ offer/answer 交換中に複数回呼ばれても最初の状態を保持する。
   */
  beginRemoteOffer() {
    if (this.remoteOfferSnapshot) {
      return;
    }
    this.remoteOfferSnapshot = {
      transceivers: [...this.transceivers],
      states: new Map(
        this.transceivers.map((t) => [
          t,
          {
            mid: t.mid,
            mLineIndex: t.mLineIndex,
            pendingRejection: t.pendingRejection,
            firedReceiving: t.firedReceiving,
          },
        ]),
      ),
    };
  }

  /**
   * local answer の確定で、拒否予定の m-line を停止・解放する。
   * remote SDP 起因の停止なので negotiationneeded は要求しない。
   */
  commitRemoteOffer() {
    this.remoteOfferSnapshot = undefined;
    for (const transceiver of this.transceivers) {
      if (transceiver.pendingRejection) {
        transceiver.commitStopped({ rejected: true });
      }
    }
  }

  /**remote offer の rollback で transceiver 対応を元に戻す */
  rollbackRemoteOffer() {
    const snapshot = this.remoteOfferSnapshot;
    this.remoteOfferSnapshot = undefined;
    if (!snapshot) {
      return;
    }

    for (const transceiver of this.transceivers) {
      if (snapshot.states.has(transceiver)) {
        continue;
      }
      if (transceiver.sender.track) {
        // rollback 中に addTrack された transceiver は残し、関連付けだけ外す
        transceiver.mid = null;
        transceiver.mLineIndex = undefined;
        snapshot.transceivers.push(transceiver);
        continue;
      }
      // remote offer が作った transceiver は破棄する
      transceiver.forceStop();
      this.unwatchTransceiver(transceiver);
    }

    this.transceivers.splice(
      0,
      this.transceivers.length,
      ...snapshot.transceivers,
    );
    snapshot.transceivers.forEach((t) => this.watchTransceiver(t));
    for (const [transceiver, state] of snapshot.states) {
      transceiver.mid = state.mid;
      transceiver.mLineIndex = state.mLineIndex;
      transceiver.pendingRejection = state.pendingRejection;
      transceiver.firedReceiving = state.firedReceiving;
    }
  }

  /**
   * answer 確定後に、stopping のまま交渉対象になり得ない transceiver の停止を確定する。
   * (MID が確定済み local description の非ゼロ m-line にない = offer から外れる)
   * @param negotiatedMids 確定済み local description の非ゼロ port の MID
   * @returns 次の自分の offer で port 0 を交渉すべき transceiver があるか
   */
  settleStoppingTransceivers(negotiatedMids: Set<string>) {
    for (const t of this.transceivers) {
      if (!t.stopping || t.stopped) {
        continue;
      }
      if (t.mid == undefined || !negotiatedMids.has(t.mid)) {
        t.commitStopped({ rejected: false });
      }
    }
    return this.transceivers.some((t) => t.stopping && !t.stopped);
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
      this.unwatchTransceiver(transceiver);
    }

    this.onTransceiverAdded.allUnsubscribe();
    this.onRemoteTransceiverAdded.allUnsubscribe();
    this.onTrack.allUnsubscribe();
    this.onNegotiationNeeded.allUnsubscribe();
  }
}
