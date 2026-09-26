import { DISCARD_HOST, DISCARD_PORT } from "./const";
import { createWebRtcDomException } from "./errors";
import type { RTCRtpTransceiver } from "./media";
import {
  type RTCRtpCodecParameters,
  RTCRtpSimulcastParameters,
} from "./media/parameters";
import type { MediaDirection } from "./media/rtpTransceiver";
import {
  type BundlePolicy,
  GroupDescription,
  MediaDescription,
  SessionDescription,
  SsrcDescription,
  addSDPHeader,
} from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import type { RTCSctpTransport } from "./transport/sctp";
import { andDirection } from "./utils";

export class SDPManager {
  currentLocalDescription?: SessionDescription;
  currentRemoteDescription?: SessionDescription;
  pendingLocalDescription?: SessionDescription;
  pendingRemoteDescription?: SessionDescription;
  readonly cname: string;
  readonly midSuffix: boolean;
  readonly bundlePolicy?: BundlePolicy;
  readonly mLineReuse: MLineReuse;

  private seenMid = new Set<string>();

  constructor({
    cname,
    midSuffix,
    bundlePolicy,
    mLineReuse,
  }: {
    cname: string;
    midSuffix?: boolean;
    bundlePolicy?: BundlePolicy;
    mLineReuse?: MLineReuse;
  }) {
    this.cname = cname;
    this.midSuffix = midSuffix ?? false;
    this.bundlePolicy = bundlePolicy;
    this.mLineReuse = mLineReuse ?? "compatible";
  }

  get localDescription() {
    if (!this._localDescription) {
      return undefined;
    }
    return this._localDescription.toJSON();
  }

  get remoteDescription() {
    if (!this._remoteDescription) {
      return undefined;
    }
    return this._remoteDescription.toJSON();
  }

  /**@private */
  get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  /**@private */
  get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  get inactiveRemoteMedia() {
    return this._remoteDescription?.media?.find?.(
      (m) => m.direction === "inactive",
    );
  }

  /**
   * MediaDescriptionをトランシーバー用に作成
   */
  createMediaDescriptionForTransceiver(
    transceiver: RTCRtpTransceiver,
    direction: MediaDirection,
  ): MediaDescription {
    const media = new MediaDescription(
      transceiver.kind,
      9,
      "UDP/TLS/RTP/SAVPF",
      transceiver.codecs.map((c) => c.payloadType),
    );
    media.direction = direction;
    media.msids = transceiver.msids;
    media.rtp = {
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      muxId: transceiver.mid ?? undefined,
    };
    media.rtcpHost = "0.0.0.0";
    media.rtcpPort = 9;
    media.rtcpMux = true;
    media.ssrc = [
      new SsrcDescription({ ssrc: transceiver.sender.ssrc, cname: this.cname }),
    ];

    if (transceiver.options.simulcast) {
      media.simulcastParameters = transceiver.options.simulcast.map(
        (o) => new RTCRtpSimulcastParameters(o),
      );
    }

    if (media.rtp.codecs.find((c) => c.name.toLowerCase() === "rtx")) {
      media.ssrc.push(
        new SsrcDescription({
          ssrc: transceiver.sender.rtxSsrc,
          cname: this.cname,
        }),
      );
      media.ssrcGroup = [
        new GroupDescription("FID", [
          transceiver.sender.ssrc.toString(),
          transceiver.sender.rtxSsrc.toString(),
        ]),
      ];
    }

    this.addTransportDescription(media, transceiver.dtlsTransport);
    return media;
  }

  /**
   * 拒否 / 停止した m-line を作成する (RFC 3264 §6 / RFC 8829 §5.3.1)。
   * port は 0、proto と MID は元の m-line を保ち、fmt は少なくとも 1 token 残す。
   */
  createRejectedMediaDescription(
    source: {
      kind: MediaDescription["kind"];
      profile: string;
      fmt: (string | number)[];
      codecs: RTCRtpCodecParameters[];
      mid?: string;
    },
    dtlsTransport?: RTCDtlsTransport,
  ): MediaDescription {
    const format = source.fmt[0] ?? source.codecs[0]?.payloadType ?? 0;
    const media = new MediaDescription(source.kind, 0, source.profile, [
      format,
    ] as string[] | number[]);
    media.host = DISCARD_HOST;
    media.direction = "inactive";
    media.rtp = {
      codecs: source.codecs.filter(
        (codec) => codec.payloadType?.toString() === format.toString(),
      ),
      headerExtensions: [],
      muxId: source.mid,
    };
    media.rtcpMux = true;
    if (dtlsTransport) {
      // 候補は載せず、ICE / DTLS の識別子だけを残す
      media.iceParams = dtlsTransport.iceTransport.localParameters;
      media.dtlsParams = dtlsTransport.localParameters;
    }
    return media;
  }

  /**
   * MediaDescriptionをSCTP用に作成
   */
  createMediaDescriptionForSctp(sctp: RTCSctpTransport): MediaDescription {
    const media = new MediaDescription(
      "application",
      DISCARD_PORT,
      "UDP/DTLS/SCTP",
      ["webrtc-datachannel"],
    );
    media.sctpPort = sctp.port;
    media.rtp.muxId = sctp.mid;
    media.sctpCapabilities = sctp.getCapabilities();

    this.addTransportDescription(media, sctp.dtlsTransport);
    return media;
  }

  /**
   * トランスポートの情報をMediaDescriptionに追加
   */
  addTransportDescription(
    media: MediaDescription,
    dtlsTransport: RTCDtlsTransport,
  ): void {
    const iceTransport = dtlsTransport.iceTransport;

    media.iceCandidates = iceTransport.localCandidates;
    media.iceCandidatesComplete = iceTransport.gatheringState === "complete";
    media.iceParams = iceTransport.localParameters;
    media.iceOptions = "trickle";

    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;

    if (media.direction === "inactive") {
      // compatible は受け入れた inactive を拒否と区別するため非ゼロ port を保つ
      if (this.mLineReuse === "aggressive") {
        media.port = 0;
      }
      media.msids = [];
    }

    if (!media.dtlsParams) {
      media.dtlsParams = dtlsTransport.localParameters;
      if (!media.dtlsParams.fingerprints) {
        media.dtlsParams.fingerprints =
          dtlsTransport.localParameters.fingerprints;
      }
    }
  }

  /**
   * 一意のMIDを割り当て
   */
  allocateMid(type: "dc" | "av" | "" = ""): string {
    let mid = "";
    for (let i = 0; ; ) {
      // rfc9143.html#name-security-considerations
      // SHOULD be 3 bytes or fewer to allow them to efficiently fit into the MID RTP header extension
      mid = (i++).toString() + type;
      if (!this.seenMid.has(mid)) break;
    }
    this.seenMid.add(mid);
    return mid;
  }

  parseSdp({
    sdp,
    isLocal,
    signalingState,
    type,
  }: {
    sdp: string;
    isLocal: boolean;
    signalingState: string;
    type: "offer" | "answer" | "pranswer";
  }): SessionDescription {
    const description = SessionDescription.parse(sdp);
    this.validateDescription({ description, isLocal, signalingState, type });
    description.type = type;
    return description;
  }

  private validateDescription({
    description,
    isLocal,
    signalingState,
    type,
  }: {
    description: SessionDescription;
    isLocal: boolean;
    signalingState: string;
    type: "offer" | "answer" | "pranswer";
  }) {
    if (isLocal) {
      if (type === "offer") {
        if (!["stable", "have-local-offer"].includes(signalingState))
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle offer in signaling state",
          );
      } else if (["answer", "pranswer"].includes(type)) {
        if (
          !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle answer in signaling state",
          );
        }
      }
    } else {
      if (type === "offer") {
        if (
          !["stable", "have-remote-offer", "have-local-offer"].includes(
            signalingState,
          )
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle offer in signaling state",
          );
        }
      } else if (["answer", "pranswer"].includes(type)) {
        if (
          !["have-local-offer", "have-remote-pranswer"].includes(signalingState)
        ) {
          throw createWebRtcDomException(
            "InvalidStateError",
            "Cannot handle answer in signaling state",
          );
        }
      }
    }
  }

  /**
   * オファーSDPを構築
   */
  buildOfferSdp(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
  ): SessionDescription {
    const description = new SessionDescription();
    addSDPHeader("offer", description);

    const fallbackDtlsTransport = this.findLiveDtlsTransport(
      transceivers,
      sctpTransport,
    );

    // # handle existing transceivers / sctp
    const currentMedia = this.currentLocalDescription?.media ?? [];
    /**過去の m-line を引き継ぐ停止済みの位置 (新しい transceiver が再利用できる) */
    const placeholderIndices = new Set<number>();

    currentMedia.forEach((m, i) => {
      const mid = m.rtp.muxId;
      if (!mid) {
        return;
      }
      if (m.kind === "application") {
        if (!sctpTransport) {
          throw new Error("sctpTransport not found");
        }
        sctpTransport.mLineIndex = i;
        description.media.push(
          this.createMediaDescriptionForSctp(sctpTransport),
        );
      } else {
        const transceiver = transceivers.find((t) => t.mid === mid);
        if (!transceiver) {
          // 再利用で transceiver が外れた位置は、新しい transceiver が来るまで port 0 で保つ
          placeholderIndices.add(i);
          description.media.push(
            this.createRejectedMediaDescription(
              {
                kind: m.kind,
                profile: m.profile,
                fmt: m.fmt,
                codecs: m.rtp.codecs,
                mid,
              },
              fallbackDtlsTransport,
            ),
          );
          return;
        }
        transceiver.mLineIndex = i;
        if (transceiver.stopping || transceiver.stopped) {
          // stop() / 拒否の確定した m-line は自分の offer で port 0 にする
          description.media.push(
            this.createRejectedMediaDescription(
              {
                kind: m.kind,
                profile: m.profile,
                fmt: m.fmt,
                codecs: m.rtp.codecs,
                mid,
              },
              this.liveTransportOr(
                transceiver.dtlsTransport,
                fallbackDtlsTransport,
              ),
            ),
          );
          return;
        }
        description.media.push(
          this.createMediaDescriptionForTransceiver(
            transceiver,
            transceiver.direction,
          ),
        );
      }
    });

    // # handle new transceivers / sctp
    for (const transceiver of transceivers.filter(
      (t) =>
        !t.stopping &&
        !t.stopped &&
        !description.media.find((m) => m.rtp.muxId === t.mid),
    )) {
      if (transceiver.mid == undefined) {
        transceiver.mid = this.allocateMid(this.midSuffix ? "av" : "");
      }
      const mediaDescription = this.createMediaDescriptionForTransceiver(
        transceiver,
        transceiver.direction,
      );
      const reservedIndex = transceiver.mLineIndex;
      if (
        reservedIndex != undefined &&
        placeholderIndices.has(reservedIndex) &&
        description.media[reservedIndex]?.kind === transceiver.kind
      ) {
        // 確定済みの port 0 位置を新しい MID で再利用する
        placeholderIndices.delete(reservedIndex);
        description.media[reservedIndex] = mediaDescription;
      } else {
        transceiver.mLineIndex = description.media.length;
        description.media.push(mediaDescription);
      }
    }

    if (
      sctpTransport &&
      !description.media.find((m) => m.kind === "application")
    ) {
      sctpTransport.mLineIndex = description.media.length;
      if (sctpTransport.mid == undefined) {
        sctpTransport.mid = this.allocateMid(this.midSuffix ? "dc" : "");
      }
      description.media.push(this.createMediaDescriptionForSctp(sctpTransport));
    }

    if (this.bundlePolicy !== "disable") {
      // RFC 8843: port 0 の m-line は BUNDLE group に含めない
      const mids = description.media
        .filter((m) => m.port !== 0)
        .map((m) => m.rtp.muxId)
        .filter((v) => v) as string[];
      if (mids.length) {
        const bundle = new GroupDescription(
          "BUNDLE",
          orderBundleMids(mids, this.negotiatedBundleTag),
        );
        description.group.push(bundle);
      }
    }

    return description;
  }

  private liveTransportOr(
    dtlsTransport: RTCDtlsTransport | undefined,
    fallback: RTCDtlsTransport | undefined,
  ) {
    return dtlsTransport && dtlsTransport.state !== "closed"
      ? dtlsTransport
      : fallback;
  }

  private findLiveDtlsTransport(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
  ) {
    return [
      ...transceivers
        .filter((t) => !t.stopped && !t.pendingRejection)
        .map((t) => t.dtlsTransport),
      sctpTransport?.dtlsTransport,
      ...transceivers.map((t) => t.dtlsTransport),
    ].find((t): t is RTCDtlsTransport => !!t && t.state !== "closed");
  }

  /**確定済み answer の BUNDLE tag (先頭 MID) */
  get negotiatedBundleTag(): string | undefined {
    const answer = [
      this.currentLocalDescription,
      this.currentRemoteDescription,
    ].find((d) => d?.type === "answer");
    return answer?.group.find((g) => g.semantic === "BUNDLE")?.items[0];
  }

  /**
   * アンサーSDPを構築
   */
  buildAnswerSdp({
    transceivers,
    sctpTransport,
    signalingState,
  }: {
    transceivers: RTCRtpTransceiver[];
    sctpTransport: RTCSctpTransport | undefined;

    signalingState: string;
  }): SessionDescription {
    if (
      !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
    ) {
      throw new Error("createAnswer failed");
    }
    if (!this._remoteDescription) {
      throw new Error("wrong state");
    }

    const description = new SessionDescription();
    addSDPHeader("answer", description);

    const remoteDescription = this._remoteDescription;
    const fallbackDtlsTransport = this.findLiveDtlsTransport(
      transceivers,
      sctpTransport,
    );

    for (const remoteMedia of remoteDescription.media) {
      let dtlsTransport: RTCDtlsTransport | undefined;
      let media: MediaDescription;
      let accepted = true;

      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver = transceivers.find(
          (t) => t.mid != undefined && t.mid === remoteMedia.rtp.muxId,
        );
        if (!transceiver && remoteMedia.port !== 0) {
          throw new Error(
            `Transceiver with mid=${remoteMedia.rtp.muxId} not found`,
          );
        }
        if (
          !transceiver ||
          remoteMedia.port === 0 ||
          transceiver.stopped ||
          transceiver.pendingRejection
        ) {
          // 非対応 / remote port 0 / 停止確定の section は同じ位置で port 0 にする
          accepted = false;
          dtlsTransport = this.liveTransportOr(
            transceiver?.dtlsTransport,
            fallbackDtlsTransport,
          );
          media = this.createRejectedMediaDescription(
            {
              kind: remoteMedia.kind,
              profile: remoteMedia.profile,
              fmt: remoteMedia.fmt,
              codecs: remoteMedia.rtp.codecs,
              mid: remoteMedia.rtp.muxId,
            },
            dtlsTransport,
          );
        } else {
          // answerer の stop() だけでは port 0 にせず、次の自分の offer で停止を交渉する
          media = this.createMediaDescriptionForTransceiver(
            transceiver,
            transceiver.stopping
              ? "inactive"
              : andDirection(transceiver.direction, transceiver.offerDirection),
          );
          dtlsTransport = transceiver.dtlsTransport;
        }
      } else if (remoteMedia.kind === "application") {
        if (!sctpTransport || !sctpTransport.mid) {
          throw new Error("sctpTransport not found");
        }
        media = this.createMediaDescriptionForSctp(sctpTransport);

        dtlsTransport = sctpTransport.dtlsTransport;
      } else {
        throw new Error("invalid kind");
      }

      // # determine DTLS role, or preserve the currently configured role
      if (media.dtlsParams && dtlsTransport) {
        if (dtlsTransport.role === "auto") {
          media.dtlsParams.role = "client";
        } else {
          media.dtlsParams.role = dtlsTransport.role;
        }
      }

      // Simulcastに関する処理
      if (
        accepted &&
        remoteMedia.simulcastParameters &&
        remoteMedia.simulcastParameters.length > 0
      ) {
        media.simulcastParameters = remoteMedia.simulcastParameters.map(
          (v) => ({
            ...v,
            direction: v.direction === "send" ? "recv" : "send",
          }),
        );
      }

      description.media.push(media);
    }

    if (this.bundlePolicy !== "disable") {
      description.group.push(
        ...this.buildAnswerBundleGroups(remoteDescription, description),
      );
    }

    return description;
  }

  /**
   * RFC 8843 §7.3: offered BUNDLE group の member のうち受け入れた MID だけで
   * answer の group を作る。確立済みの tag は保持し、初回 answer で
   * offerer-tagged を拒否した場合は受け入れた先頭 member を answerer-tagged にする。
   * 全 member を拒否した group は省略する。
   */
  private buildAnswerBundleGroups(
    remoteDescription: SessionDescription,
    answer: SessionDescription,
  ) {
    const acceptedMids = new Set(
      answer.media
        .filter((m) => m.port !== 0 && m.rtp.muxId)
        .map((m) => m.rtp.muxId!),
    );
    const negotiatedTag = this.negotiatedBundleTag;

    return remoteDescription.group
      .filter((group) => group.semantic === "BUNDLE")
      .map((group) =>
        group.items.filter((mid, index, items) => {
          return acceptedMids.has(mid) && items.indexOf(mid) === index;
        }),
      )
      .filter((mids) => mids.length > 0)
      .map(
        (mids) =>
          new GroupDescription("BUNDLE", orderBundleMids(mids, negotiatedTag)),
      );
  }

  /**
   * remote answer / pranswer を適用する前の検証。
   * 非ゼロ port の RTP m-line が pending local offer と共通 codec を持たなければ拒否する。
   */
  private assertRemoteAnswerCodecs(remoteSdp: SessionDescription) {
    if (!["answer", "pranswer"].includes(remoteSdp.type)) {
      return;
    }
    const offer = this.pendingLocalDescription;
    if (!offer) {
      return;
    }
    remoteSdp.media.forEach((media, index) => {
      if (!["audio", "video"].includes(media.kind) || media.port === 0) {
        return;
      }
      const offered = offer.media[index];
      if (!offered || offered.port === 0 || offered.kind !== media.kind) {
        return;
      }
      const hasCommonCodec = media.rtp.codecs.some(
        (codec) =>
          codec.name.toLowerCase() !== "rtx" &&
          offered.rtp.codecs.some(
            (offeredCodec) =>
              offeredCodec.mimeType.toLowerCase() ===
              codec.mimeType.toLowerCase(),
          ),
      );
      if (!hasCommonCodec) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `No common codec for m-line ${index} (mid=${media.rtp.muxId}) in remote ${remoteSdp.type}`,
        );
      }
    });
  }

  /**
   * 確立済み BUNDLE の transport を共有している m-line を、
   * re-offer が group の外へ出すことはできない (共有 transport を分割できない)。
   */
  private assertBundlePreserved(remoteSdp: SessionDescription) {
    if (remoteSdp.type !== "offer" || this.bundlePolicy === "disable") {
      return;
    }
    const negotiated = [
      this.currentLocalDescription,
      this.currentRemoteDescription,
    ]
      .find((d) => d?.type === "answer")
      ?.group.find((g) => g.semantic === "BUNDLE");
    if (!negotiated) {
      return;
    }
    const offeredGroups = remoteSdp.group.filter(
      (g) => g.semantic === "BUNDLE",
    );
    for (const mid of negotiated.items) {
      const media = remoteSdp.media.find((m) => m.rtp.muxId === mid);
      if (!media || media.port === 0) {
        continue;
      }
      if (!offeredGroups.some((g) => g.items.includes(mid))) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `BUNDLE transport of mid=${mid} cannot be preserved by the remote offer`,
        );
      }
    }
  }

  setLocalDescription(description: SessionDescription) {
    if (description.type === "offer" || description.type === "pranswer") {
      this.pendingLocalDescription = description;
      return;
    }

    this.currentLocalDescription = description;
    if (this.pendingRemoteDescription) {
      this.currentRemoteDescription = this.pendingRemoteDescription;
    }
    this.pendingLocalDescription = undefined;
    this.pendingRemoteDescription = undefined;
  }

  setRemoteDescription(
    sessionDescription: RTCSessionDescriptionInit,
    signalingState: string,
  ) {
    if (!sessionDescription.type) {
      throw new Error("invalid sessionDescription");
    }

    if (sessionDescription.type === "rollback") {
      if (
        !["have-remote-offer", "have-local-pranswer"].includes(signalingState)
      ) {
        throw createWebRtcDomException(
          "InvalidStateError",
          "Cannot rollback remote description in signaling state",
        );
      }
      this.pendingLocalDescription = undefined;
      this.pendingRemoteDescription = undefined;
      return;
    }

    if (!sessionDescription.sdp) {
      throw new Error("invalid sessionDescription");
    }

    // # parse and validate description
    const remoteSdp = this.parseSdp({
      sdp: sessionDescription.sdp,
      isLocal: false,
      signalingState,
      type: sessionDescription.type,
    });
    // 状態を変更する前に検証し、失敗時は signaling state / descriptions を保つ
    this.assertRemoteAnswerCodecs(remoteSdp);
    this.assertBundlePreserved(remoteSdp);

    if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
      this.pendingRemoteDescription = remoteSdp;
    } else {
      if (this.pendingLocalDescription) {
        this.currentLocalDescription = this.pendingLocalDescription;
      }
      this.currentRemoteDescription = remoteSdp;
      this.pendingRemoteDescription = undefined;
      this.pendingLocalDescription = undefined;
    }

    return remoteSdp;
  }

  rollbackLocalDescription(signalingState: string) {
    if (!["have-local-offer", "have-local-pranswer"].includes(signalingState)) {
      throw createWebRtcDomException(
        "InvalidStateError",
        "Cannot rollback local description in signaling state",
      );
    }
    this.pendingLocalDescription = undefined;
    this.pendingRemoteDescription = undefined;
  }

  registerMid(mid: string): void {
    this.seenMid.add(mid);
  }

  get remoteIsBundled() {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp) {
      return undefined;
    }
    const bundle = remoteSdp.group.find(
      (g) => g.semantic === "BUNDLE" && this.bundlePolicy !== "disable",
    );
    return bundle;
  }

  /**
   * ローカルセッション記述を設定し、トランスポート情報を追加する
   */
  setLocal(
    description: SessionDescription,
    transceivers: RTCRtpTransceiver[],
    sctpTransport?: { dtlsTransport: RTCDtlsTransport; mid?: string },
  ) {
    const transceiverByMLineIndex = new Map(
      transceivers.map((transceiver) => [transceiver?.mLineIndex, transceiver]),
    );
    const fallbackDtlsTransport =
      transceivers.find((transceiver) => transceiver?.dtlsTransport)
        ?.dtlsTransport ?? sctpTransport?.dtlsTransport;
    // SCTP が RTP より先にある SDP でも元の m-line index で transceiver を引く
    description.media.forEach((m, i) => {
      if (!["audio", "video"].includes(m.kind)) {
        return;
      }
      const transceiver =
        transceivers.find(
          (t) => t?.mid != undefined && t.mid === m.rtp.muxId,
        ) ?? transceiverByMLineIndex.get(i);
      if (m.port === 0) {
        const live =
          transceiver &&
          !transceiver.stopping &&
          !transceiver.stopped &&
          !transceiver.pendingRejection;
        if (!live) {
          // 拒否 / 停止した m-line には transport 情報を追加しない
          return;
        }
      }
      const dtlsTransport = transceiver?.dtlsTransport ?? fallbackDtlsTransport;
      if (!dtlsTransport) {
        throw new Error(`dtls transport not found for media index ${i}`);
      }
      const port = m.port;
      this.addTransportDescription(m, dtlsTransport);
      if (port === 0) {
        m.port = 0;
      }
    });
    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (sctpTransport && sctpMedia) {
      this.addTransportDescription(sctpMedia, sctpTransport.dtlsTransport);
    }

    this.setLocalDescription(description);
  }
}

/**確立済み tag が含まれていれば先頭に置き、それ以外は元の順序を保つ */
function orderBundleMids(mids: string[], preferredTag?: string) {
  if (!preferredTag || !mids.includes(preferredTag)) {
    return mids;
  }
  return [preferredTag, ...mids.filter((mid) => mid !== preferredTag)];
}

export type MLineReuse = "compatible" | "aggressive";

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
