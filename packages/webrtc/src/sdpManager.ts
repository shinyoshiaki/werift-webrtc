import { DISCARD_HOST, DISCARD_PORT } from "./const";
import { createWebRtcDomException } from "./errors";
import type { RTCRtpTransceiver } from "./media";
import { RTCRtpSimulcastParameters } from "./media/parameters";
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

  private seenMid = new Set<string>();

  constructor({
    cname,
    midSuffix,
    bundlePolicy,
  }: { cname: string; midSuffix?: boolean; bundlePolicy?: BundlePolicy }) {
    this.cname = cname;
    this.midSuffix = midSuffix ?? false;
    this.bundlePolicy = bundlePolicy;
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
      media.port = 0;
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
    this.validateSections(description, type, isLocal);
    description.type = type;
    return description;
  }

  /** Checks cross-section constraints before any media or transport is changed. */
  private validateSections(
    description: SessionDescription,
    type: "offer" | "answer" | "pranswer",
    isLocal: boolean,
  ) {
    const mids = description.media.map((media) => media.rtp.muxId);
    const presentMids = mids.filter((mid): mid is string => !!mid);
    if (new Set(presentMids).size !== presentMids.length) {
      throw createWebRtcDomException("OperationError", "Duplicate MID in SDP");
    }

    for (const group of description.group.filter(
      (group) => group.semantic === "BUNDLE",
    )) {
      const resolvesMid = (item: string) =>
        presentMids.includes(item) ||
        presentMids.some((mid) => mid.startsWith(`${item}_`));
      if (
        new Set(group.items).size !== group.items.length ||
        group.items.some((mid) => !resolvesMid(mid))
      ) {
        throw createWebRtcDomException(
          "OperationError",
          "Invalid BUNDLE group in SDP",
        );
      }
    }

    const previous = isLocal
      ? this.currentLocalDescription
      : this.currentRemoteDescription;
    if (previous) {
      for (const [index, oldMedia] of previous.media.entries()) {
        const next = description.media[index];
        const reusable =
          oldMedia.port === 0 || oldMedia.direction === "inactive";
        if (
          !next ||
          (next.kind !== oldMedia.kind && oldMedia.port !== 0) ||
          (oldMedia.rtp.muxId &&
            next.rtp.muxId !== oldMedia.rtp.muxId &&
            !reusable)
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Existing m-lines must retain their order, kind and MID",
          );
        }
      }
    }

    if (type === "offer") return;
    const offer = isLocal
      ? this.pendingRemoteDescription
      : this.pendingLocalDescription;
    if (!offer || description.media.length !== offer.media.length) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "Answer m-lines must match the offer",
      );
    }
    for (const [index, media] of description.media.entries()) {
      const offered = offer.media[index];
      if (
        media.kind !== offered.kind ||
        (offered.rtp.muxId &&
          media.rtp.muxId !== offered.rtp.muxId &&
          !media.rtp.muxId?.startsWith(`${offered.rtp.muxId}_`))
      ) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Answer m-lines must match the offer",
        );
      }
      if (media.port !== 0 && offered.port === 0) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Answer cannot accept a rejected m-line",
        );
      }
    }
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
        if (
          !["stable", "have-local-offer", "have-remote-pranswer"].includes(
            signalingState,
          )
        )
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
          ![
            "stable",
            "have-remote-offer",
            "have-local-offer",
            "have-local-pranswer",
          ].includes(signalingState)
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

    // # handle existing transceivers / sctp
    const currentMedia = this.currentLocalDescription?.media ?? [];

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
          if (m.direction === "inactive") {
            description.media.push(m);
            return;
          }
          throw new Error("transceiver not found");
        }
        transceiver.mLineIndex = i;
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
      (t) => !description.media.find((m) => m.rtp.muxId === t.mid),
    )) {
      if (transceiver.mid == undefined) {
        transceiver.mid = this.allocateMid(this.midSuffix ? "av" : "");
      }
      const mediaDescription = this.createMediaDescriptionForTransceiver(
        transceiver,
        transceiver.direction,
      );
      if (transceiver.mLineIndex === undefined) {
        transceiver.mLineIndex = description.media.length;
        description.media.push(mediaDescription);
      } else {
        description.media[transceiver.mLineIndex] = mediaDescription;
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
      const mids = description.media
        .map((m) => m.rtp.muxId)
        .filter((v) => v) as string[];
      if (mids.length) {
        const bundle = new GroupDescription("BUNDLE", mids);
        description.group.push(bundle);
      }
    }

    return description;
  }

  /**
   * アンサーSDPを構築
   */
  buildAnswerSdp({
    transceivers,
    sctpTransport,
    signalingState,
    transportByMid,
  }: {
    transceivers: RTCRtpTransceiver[];
    sctpTransport: RTCSctpTransport | undefined;
    signalingState: string;
    transportByMid?: Map<string, RTCDtlsTransport>;
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

    for (const remoteMedia of this._remoteDescription.media) {
      let dtlsTransport!: RTCDtlsTransport;
      let media: MediaDescription;

      if (remoteMedia.port === 0) {
        media = new MediaDescription(
          remoteMedia.kind,
          0,
          remoteMedia.profile,
          remoteMedia.fmt,
        );
        media.rtp.muxId = remoteMedia.rtp.muxId;
        media.direction = "inactive";
        description.media.push(media);
        continue;
      }

      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver = transceivers.find(
          (t) => t.mid === remoteMedia.rtp.muxId,
        );
        if (!transceiver) {
          throw new Error(
            `Transceiver with mid=${remoteMedia.rtp.muxId} not found`,
          );
        }
        media = this.createMediaDescriptionForTransceiver(
          transceiver,
          andDirection(transceiver.direction, transceiver.offerDirection),
        );
        if (media.port === 0) media.fmt = remoteMedia.fmt;
        dtlsTransport = transceiver.dtlsTransport;
      } else if (remoteMedia.kind === "application") {
        if (!sctpTransport || !sctpTransport.mid) {
          throw new Error("sctpTransport not found");
        }
        media = this.createMediaDescriptionForSctp(sctpTransport);

        dtlsTransport = sctpTransport.dtlsTransport;
      } else {
        throw new Error("invalid kind");
      }

      const proposedTransport =
        remoteMedia.rtp.muxId && transportByMid?.get(remoteMedia.rtp.muxId);
      if (proposedTransport) {
        dtlsTransport = proposedTransport;
        this.addTransportDescription(media, proposedTransport);
      }

      // # determine DTLS role, or preserve the currently configured role
      if (media.dtlsParams) {
        if (dtlsTransport.role === "auto") {
          media.dtlsParams.role = "client";
        } else {
          media.dtlsParams.role = dtlsTransport.role;
        }
      }

      // Simulcastに関する処理
      if (
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

    const offeredBundle = this._remoteDescription.group.find(
      (group) => group.semantic === "BUNDLE",
    );
    if (this.bundlePolicy !== "disable" && offeredBundle) {
      const acceptedMids = new Set(
        description.media.map((media) => media.rtp.muxId),
      );
      const items = offeredBundle.items.filter((mid) => acceptedMids.has(mid));
      if (items.length) {
        description.group.push(new GroupDescription("BUNDLE", items));
      }
    }

    return description;
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
        ![
          "have-remote-offer",
          "have-local-pranswer",
          "have-remote-pranswer",
        ].includes(signalingState)
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

    this.applyRemoteDescription(remoteSdp);

    return remoteSdp;
  }

  applyRemoteDescription(remoteSdp: SessionDescription) {
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
  }

  rollbackLocalDescription(signalingState: string) {
    if (
      ![
        "have-local-offer",
        "have-local-pranswer",
        "have-remote-pranswer",
      ].includes(signalingState)
    ) {
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
    transportByMid?: Map<string, RTCDtlsTransport>,
  ) {
    const transceiverByMLineIndex = new Map(
      transceivers.map((transceiver) => [transceiver?.mLineIndex, transceiver]),
    );
    const fallbackDtlsTransport =
      transceivers.find((transceiver) => transceiver?.dtlsTransport)
        ?.dtlsTransport ?? sctpTransport?.dtlsTransport;
    description.media.forEach((m, i) => {
      if (!["audio", "video"].includes(m.kind)) return;
      const transceiver = transceiverByMLineIndex.get(i) ?? transceivers[i];
      const dtlsTransport =
        (m.rtp.muxId && transportByMid?.get(m.rtp.muxId)) ||
        transceiver?.dtlsTransport ||
        fallbackDtlsTransport;
      if (!dtlsTransport) {
        throw new Error(`dtls transport not found for media index ${i}`);
      }
      this.addTransportDescription(m, dtlsTransport);
    });
    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (sctpTransport && sctpMedia) {
      this.addTransportDescription(
        sctpMedia,
        (sctpMedia.rtp.muxId && transportByMid?.get(sctpMedia.rtp.muxId)) ||
          sctpTransport.dtlsTransport,
      );
    }

    this.setLocalDescription(description);
  }
}

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
