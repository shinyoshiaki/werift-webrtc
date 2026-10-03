import { type PeerConfig, findCodecByMimeType } from "./api/peerConfig";
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
import {
  assertCodecsSupported,
  hasCommonPrimaryMimeType,
  isCodecCompatible,
  resolveCodecs,
} from "./media/codecCompatibility";
import type { RTCStats } from "./media/stats";
import { captureTrackSourceCodecs, getTrackSourceCodecs } from "./media/track";
import {
  type MediaDescription,
  type SessionDescription,
  codecParametersFromString,
} from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { Kind } from "./types/domain";
import { reverseDirection } from "./utils";

const log = debug("werift:packages/webrtc/src/media/rtpTransceiverManager.ts");

/**
 * Remote codecs of an m-line that local codecs support. RTX is kept only when
 * the codec its `apt` names is kept too. Pre-validation and application use
 * the same rule, so an m-line that negotiates nothing is rejected up front.
 */
export function negotiateRemoteCodecs(
  localCodecs: RTCRtpCodecParameters[],
  remoteMedia: MediaDescription,
) {
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
  private readonly notifiedRemoteTrack = new WeakMap<
    RTCRtpTransceiver,
    { track: MediaStreamTrack; streams: string[] }
  >();
  private readonly watched = new WeakSet<RTCRtpTransceiver>();

  getNotifiedRemoteTrack(transceiver: RTCRtpTransceiver) {
    const state = this.notifiedRemoteTrack.get(transceiver);
    return state && { track: state.track, streams: [...state.streams] };
  }

  restoreNotifiedRemoteTrack(
    transceiver: RTCRtpTransceiver,
    state: ReturnType<TransceiverManager["getNotifiedRemoteTrack"]>,
  ) {
    if (state) this.notifiedRemoteTrack.set(transceiver, state);
    else this.notifiedRemoteTrack.delete(transceiver);
  }

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
    return (
      this.transceivers.find(
        (transceiver) =>
          transceiver.mLineIndex === index && !transceiver.stopped,
      ) ??
      this.transceivers.find((transceiver) => transceiver.mLineIndex === index)
    );
  }

  restoreTransceiverOrder(baseline: RTCRtpTransceiver[]) {
    const attachedLater = this.transceivers.filter(
      (transceiver) => !baseline.includes(transceiver),
    );
    this.transceivers.splice(
      0,
      this.transceivers.length,
      ...baseline,
      ...attachedLater,
    );
    // A transceiver taken off its m-line by the rolled-back offer is back.
    baseline.forEach((t) => this.watchTransceiver(t));
  }

  pushTransceiver(t: RTCRtpTransceiver): void {
    this.watchTransceiver(t);
    this.transceivers.push(t);
  }

  /** Remove an uncommitted transceiver created only by a remote offer. */
  removeRemoteTransceiver(transceiver: RTCRtpTransceiver): void {
    const index = this.transceivers.indexOf(transceiver);
    if (index < 0) return;
    transceiver.forceStop();
    transceiver.mid = null;
    transceiver.mLineIndex = undefined;
    this.transceivers.splice(index, 1);
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

  /**
   * 既存の未関連付け transceiver を remote m-line の位置に関連付ける。
   * 同じ位置に停止済みの旧 transceiver があれば m-line から外し、配列上でも置き換える。
   * (旧 transceiver が位置を持ったままだと MID の割り当て先が重複する)
   */
  associateMLine(transceiver: RTCRtpTransceiver, mLineIndex: number) {
    const previous = this.transceivers.find(
      (t) => t !== transceiver && t.stopped && t.mLineIndex === mLineIndex,
    );
    if (!previous) {
      return;
    }
    this.transceivers.splice(this.transceivers.indexOf(transceiver), 1);
    this.takeOverMLine(previous, transceiver);
  }

  /**
   * remote offer が定義した位置のうち、関連付けられなかった未交渉 transceiver の予約を解除する。
   * (remote が予約位置を別 kind や別 transceiver で再利用した場合、次の offer で末尾に追加させる)
   */
  releaseUnassociatedReservations(
    associated: Set<RTCRtpTransceiver>,
    mLineCount: number,
  ) {
    for (const t of this.transceivers) {
      if (
        !associated.has(t) &&
        t.mid == null &&
        t.mLineIndex != undefined &&
        t.mLineIndex < mLineCount
      ) {
        t.mLineIndex = undefined;
      }
    }
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

    if (typeof trackOrKind !== "string") {
      captureTrackSourceCodecs(trackOrKind);
      assertCodecsSupported({
        kind,
        configured: this.filterCodecsByDirection(kind, direction),
        source: getTrackSourceCodecs(trackOrKind),
        preferences: undefined,
      });
    }

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
    newTransceiver.onCodecPreferencesChanged.subscribe(() => {
      this.onNegotiationNeeded.execute();
    });
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

    // 旧 transceiver は復活させず、MID は次の offer で新しく割り当てる。
    // 同じ kind で拒否 / 停止の交渉が確定した位置だけを再利用する (inactive は奪わない)
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
      this.validateTrackForTransceiver(track, emptyTrackSenderTransceiver);
      const sender = emptyTrackSenderTransceiver.sender;
      sender.setStreams(streams);
      sender.registerTrack(track);
      emptyTrackSenderTransceiver.options = {
        ...emptyTrackSenderTransceiver.options,
        streams,
      };
      emptyTrackSenderTransceiver.codecs = [];
      return emptyTrackSenderTransceiver;
    }

    const notSendTransceiver = this.transceivers.find(
      (t) => reusableForTrack(t) && !SenderDirections.includes(t.direction),
    );
    if (notSendTransceiver) {
      const nextDirection =
        notSendTransceiver.direction === "recvonly"
          ? "sendrecv"
          : notSendTransceiver.direction === "inactive"
            ? "sendonly"
            : notSendTransceiver.direction;
      this.validateTrackForTransceiver(
        track,
        notSendTransceiver,
        nextDirection,
      );
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
      notSendTransceiver.codecs = [];
      return notSendTransceiver;
    } else {
      const transceiver = this.addTransceiver(track, undefined, {
        direction: "sendrecv",
        streams,
      });
      return transceiver;
    }
  }

  /**
   * sender から track を外す。
   * @returns 交渉が必要な変更をした場合 true (呼び出し側が negotiationneeded を要求する)
   */
  removeTrack(sender: RTCRtpSender): boolean {
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
      return false;
    }

    if (sender.track == undefined) {
      return false;
    }

    // sender 自体は止めず track だけ外し、同じ sender で送信を再開できるようにする
    sender.detachTrack();

    if (transceiver.direction === "sendrecv") {
      transceiver.setDirection("recvonly");
    } else if (transceiver.direction === "sendonly") {
      transceiver.setDirection("inactive");
    }
    return true;
  }

  assignTransceiverCodecs(transceiver: RTCRtpTransceiver): void {
    const configured = this.filterCodecsByDirection(
      transceiver.kind,
      transceiver.direction,
    );
    transceiver.codecs = assertCodecsSupported({
      kind: transceiver.kind,
      configured,
      source: getTrackSourceCodecs(transceiver.sender.track),
      preferences: transceiver.codecPreferences,
    });
    transceiver.codecPreferencesNeedResolution = false;
  }

  private filterCodecsByDirection(
    kind: Kind,
    direction: RTCRtpTransceiver["direction"],
  ) {
    return (this.config.codecs[kind] as RTCRtpCodecParameters[]).filter(
      (codecCandidate) => {
        switch (codecCandidate.direction) {
          case "recvonly": {
            if (ReceiverDirection.includes(direction)) return true;
            return false;
          }
          case "sendonly": {
            if (SenderDirections.includes(direction)) return true;
            return false;
          }
          case "sendrecv": {
            if ([Sendrecv, Recvonly, Sendonly].includes(direction)) return true;
            return false;
          }
          case "all": {
            return true;
          }
          default:
            return false;
        }
      },
    );
  }

  private validateTrackForTransceiver(
    track: MediaStreamTrack,
    transceiver: RTCRtpTransceiver,
    direction = transceiver.direction,
  ) {
    captureTrackSourceCodecs(track);
    assertCodecsSupported({
      kind: track.kind,
      configured: this.filterCodecsByDirection(track.kind, direction),
      source: getTrackSourceCodecs(track),
      preferences: transceiver.codecPreferences,
    });
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
   * remote offer と local (source constraint + preferences) から
   * answer 用の codec だけを再解決する (sender/receiver の同期なし)。
   * setRemoteRTP() の交渉部分として使う。
   */
  private resolveRemoteCodecSet(
    localCodecs: RTCRtpCodecParameters[],
    remoteMedia: MediaDescription,
    order: "local" | "remote",
    source?: readonly RTCRtpCodecParameters[],
  ): RTCRtpCodecParameters[] {
    // # negotiate codecs
    const codecName = (codec: RTCRtpCodecParameters) =>
      codec.name.toLowerCase();
    const redPayloadTypes = (codec: RTCRtpCodecParameters) =>
      (codec.parameters ?? "")
        .split("/")
        .map(Number)
        .filter((payloadType) => !Number.isNaN(payloadType));
    const remoteByLocal = new Map<
      RTCRtpCodecParameters,
      RTCRtpCodecParameters[]
    >();
    for (const localCodec of localCodecs) {
      if (["red", "rtx"].includes(codecName(localCodec))) continue;
      const remoteCodecs = remoteMedia.rtp.codecs.filter(
        (codec) =>
          codec.mimeType.toLowerCase() === localCodec.mimeType.toLowerCase() &&
          (source == undefined ||
            source.some((sourceCodec) =>
              isCodecCompatible(sourceCodec, codec),
            )),
      );
      if (remoteCodecs.length > 0) remoteByLocal.set(localCodec, remoteCodecs);
    }

    const negotiated = localCodecs.flatMap((localCodec) => {
      if (codecName(localCodec) === "red") {
        const remotePrimaryPayloadTypes = redPayloadTypes(localCodec).flatMap(
          (payloadType) => {
            const localPrimary = localCodecs.find(
              (codec) => codec.payloadType === payloadType,
            );
            const remotePrimary = localPrimary
              ? remoteByLocal.get(localPrimary)
              : undefined;
            return remotePrimary?.map((codec) => codec.payloadType) ?? [];
          },
        );
        const remoteRed = remoteMedia.rtp.codecs.find((codec) => {
          if (codecName(codec) !== "red") return false;
          const referenced = redPayloadTypes(codec);
          return (
            referenced.length === remotePrimaryPayloadTypes.length &&
            referenced.every(
              (payloadType, index) =>
                payloadType === remotePrimaryPayloadTypes[index],
            )
          );
        });
        if (!remoteRed) return [];
        return [remoteRed];
      }

      if (codecName(localCodec) !== "rtx") {
        return remoteByLocal.get(localCodec) ?? [];
      }

      const localApt = codecParametersFromString(
        localCodec.parameters ?? "",
      ).apt;
      const localPrimary = localCodecs.find(
        (codec) => codec.payloadType === localApt,
      );
      if (!localPrimary) return [];
      const remotePrimaryPayloadTypes = new Set(
        remoteByLocal.get(localPrimary)?.map((codec) => codec.payloadType),
      );
      return remoteMedia.rtp.codecs.filter(
        (codec) =>
          codecName(codec) === "rtx" &&
          remotePrimaryPayloadTypes.has(
            codecParametersFromString(codec.parameters ?? "").apt,
          ),
      );
    });
    const uniqueNegotiated = [...new Set(negotiated)];
    if (order === "remote") {
      const remoteOrder = new Map(
        remoteMedia.rtp.codecs.map((codec, index) => [codec, index]),
      );
      uniqueNegotiated.sort(
        (left, right) => remoteOrder.get(left)! - remoteOrder.get(right)!,
      );
    }
    if (uniqueNegotiated.length === 0) {
      throw createWebRtcDomException(
        "NotSupportedError",
        "No compatible codec remains after remote negotiation.",
      );
    }
    return uniqueNegotiated;
  }

  refreshAnswerCodecs(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
  ): void {
    const configured = this.config.codecs[remoteMedia.kind] || [];
    const source = getTrackSourceCodecs(transceiver.sender.track);
    assertCodecsSupported({
      kind: remoteMedia.kind,
      configured,
      source,
      preferences: transceiver.codecPreferences,
    });
    const localCodecs = resolveCodecs(
      configured,
      source,
      transceiver.codecPreferences,
    );
    transceiver.codecs = this.resolveRemoteCodecSet(
      localCodecs,
      remoteMedia,
      "local",
      source,
    );
    log("negotiated codecs", transceiver.codecs);
  }

  /** Commit an answer's refreshed codec proposal to sender and receiver state. */
  commitAnswerCodecs(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
  ) {
    transceiver.sender.prepareSend(this.getLocalRtpParams(transceiver));
    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remoteParams = this.getRemoteRtpParams(remoteMedia, transceiver);
      for (const param of remoteMedia.simulcastParameters) {
        this.router.registerRtpReceiverByRid(transceiver, param, remoteParams);
      }
      transceiver.receiver.resyncCodecs(
        remoteParams,
        remoteMedia.ssrc[0]?.ssrc,
      );
      this.router.registerRtpReceiverBySsrc(transceiver, remoteParams);
    }
    transceiver.codecPreferencesNeedResolution = false;
  }

  /**
   * remote SDP の全 audio/video m-line の codec を副作用なしで解決する。
   * transceiver の対応付けは本適用と同じ resolver を使い、検証と適用の判定をずらさない。
   * - port 0、停止済み / 停止中の m-line は codec 解決をしない (空)
   * - local capability と MIME が 1 つも一致しない m-line は空とし、
   *   offer は setRemoteRTP() で拒否 (port 0 answer)、answer/pranswer は
   *   SDPManager が InvalidAccessError とする (Issue #705)
   * - source constraint / preference / pending offer との不一致は NotSupportedError
   */
  planRemoteRtpCodecs(
    remoteSdp: SessionDescription,
    findTransceiver: (
      remoteMedia: MediaDescription,
      index: number,
    ) => RTCRtpTransceiver | undefined,
  ): Map<number, RTCRtpCodecParameters[]> {
    const plan = new Map<number, RTCRtpCodecParameters[]>();
    const isOffer = remoteSdp.type === "offer";
    for (const [index, remoteMedia] of remoteSdp.media.entries()) {
      if (!["audio", "video"].includes(remoteMedia.kind)) continue;
      const transceiver = findTransceiver(remoteMedia, index);
      if (
        remoteMedia.port === 0 ||
        transceiver?.stopped ||
        transceiver?.stopping
      ) {
        plan.set(index, []);
        continue;
      }
      const source = getTrackSourceCodecs(transceiver?.sender.track);
      const configured = this.config.codecs[remoteMedia.kind] || [];
      const localCodecs = isOffer
        ? configured
        : transceiver?.pendingLocalOfferCodecs || [];
      if (!hasCommonPrimaryMimeType(localCodecs, remoteMedia.rtp.codecs)) {
        plan.set(index, []);
        continue;
      }
      if (isOffer) {
        assertCodecsSupported({
          kind: remoteMedia.kind,
          configured,
          source,
          preferences: transceiver?.codecPreferences,
        });
      }
      const negotiated = this.resolveRemoteCodecSet(
        isOffer
          ? resolveCodecs(configured, source, transceiver?.codecPreferences)
          : localCodecs,
        remoteMedia,
        "remote",
        source,
      );
      if (source != undefined) {
        assertCodecsSupported({
          kind: remoteMedia.kind,
          configured: negotiated,
          source,
          preferences: undefined,
        });
      }
      plan.set(index, negotiated);
    }
    return plan;
  }

  /**
   * remote m-line を transceiver に適用する。
   * codecs は planRemoteRtpCodecs() で検証済みの解決結果を渡す。
   * codec が空、または remote port 0 の m-line は拒否として扱い、
   * sender/receiver 準備・router 登録・onTrack・TWCC を行わない。
   * @returns 受け入れた (RTP を流す) 場合 true
   */
  setRemoteRTP(
    transceiver: RTCRtpTransceiver,
    remoteMedia: MediaDescription,
    type: "offer" | "answer" | "pranswer",
    mLineIndex: number,
    codecs: RTCRtpCodecParameters[],
  ): boolean {
    if (!transceiver.mid) {
      transceiver.mid = remoteMedia.rtp.muxId ?? null;
    }
    transceiver.mLineIndex = mLineIndex;
    if (type === "answer") transceiver.pendingLocalOfferCodecs = undefined;

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
    // During a re-offer the committed sender keeps its codec until the final
    // answer. The proposed codec remains on the transceiver for createAnswer.
    if (type !== "offer" || !transceiver.currentDirection) {
      transceiver.sender.prepareSend(localParams);
    }

    if (["recvonly", "sendrecv"].includes(transceiver.direction)) {
      const remotePrams = this.getRemoteRtpParams(remoteMedia, transceiver);

      // A pending offer or pranswer may add routes and decode entries, but a
      // key the current session uses keeps its value until the commit.
      const staging = { deferConflicts: type !== "answer" };
      // register simulcast receiver
      for (const param of remoteMedia.simulcastParameters) {
        this.router.registerRtpReceiverByRid(
          transceiver,
          param,
          remotePrams,
          staging,
        );
      }

      if (type === "answer") {
        transceiver.receiver.resyncCodecs(
          remotePrams,
          remoteMedia.ssrc[0]?.ssrc,
        );
      } else {
        transceiver.receiver.prepareReceive(remotePrams, staging);
      }
      // register ssrc receiver
      this.router.registerRtpReceiverBySsrc(transceiver, remotePrams, staging);
    }
    if (["sendonly", "sendrecv"].includes(mediaDirection)) {
      const remoteStreamIds = [
        ...new Set(remoteMedia.msids.map((msid) => msid.split(" ")[0])),
      ];
      const remoteTrackId = remoteMedia.msids[0]?.split(" ")[1];
      transceiver.receiver.remoteStreamId = remoteStreamIds[0];
      transceiver.receiver.remoteStreamIds = remoteStreamIds;
      transceiver.receiver.remoteTrackId = remoteTrackId;

      const track = transceiver.receiver.track;
      const previous = this.notifiedRemoteTrack.get(transceiver);
      if (
        previous?.track !== track ||
        previous.streams.join("\0") !== remoteStreamIds.join("\0")
      ) {
        this.notifiedRemoteTrack.set(transceiver, {
          track,
          streams: remoteStreamIds,
        });
        this.onTrack.execute({
          track,
          transceiver,
          streams: remoteStreamIds.map(
            (id) => new MediaStream({ id, tracks: [track] }),
          ),
        });
      }
      transceiver.firedReceiving = true;
    } else {
      this.notifiedRemoteTrack.delete(transceiver);
      transceiver.firedReceiving = false;
    }

    // A pending offer or pranswer does not start transport-cc feedback for
    // the current stream; the receiver starts it from a packet whose codec
    // negotiated it, or here once the description is an answer.
    if (
      (type === "answer" || !transceiver.currentDirection) &&
      remoteMedia.ssrc[0]?.ssrc
    ) {
      transceiver.receiver.setupTWCC(remoteMedia.ssrc[0].ssrc);
    }
    return true;
  }

  /**
   * local answer の確定で、拒否予定の m-line を停止・解放する。
   * remote SDP 起因の停止なので negotiationneeded は要求しない。
   */
  commitRemoteOffer() {
    for (const transceiver of this.transceivers) {
      if (transceiver.pendingRejection) {
        transceiver.commitStopped({ rejected: true });
      }
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
