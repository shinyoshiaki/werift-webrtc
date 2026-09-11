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
    dtlsTransport = transceiver.dtlsTransport,
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

    this.addTransportDescription(media, dtlsTransport);
    if (transceiver.stopped || transceiver.stopping) {
      media.port = 0;
      media.msids = [];
    }
    return media;
  }

  /**
   * MediaDescriptionをSCTP用に作成
   */
  createMediaDescriptionForSctp(
    sctp: RTCSctpTransport,
    dtlsTransport = sctp.dtlsTransport,
    sctpPort = sctp.port,
  ): MediaDescription {
    const media = new MediaDescription(
      "application",
      DISCARD_PORT,
      "UDP/DTLS/SCTP",
      ["webrtc-datachannel"],
    );
    media.sctpPort = sctpPort;
    media.rtp.muxId = sctp.mid;
    media.sctpCapabilities = sctp.getCapabilities();

    this.addTransportDescription(media, dtlsTransport);
    return media;
  }

  /**
   * トランスポートの情報をMediaDescriptionに追加
   */
  addTransportDescription(
    media: MediaDescription,
    dtlsTransport: RTCDtlsTransport,
    replaceDtls = false,
  ): void {
    const iceTransport = dtlsTransport.iceTransport;

    media.iceCandidates = iceTransport.localCandidates;
    media.iceCandidatesComplete = iceTransport.gatheringState === "complete";
    media.iceParams = iceTransport.localParameters;
    media.iceOptions = "trickle";

    media.host = DISCARD_HOST;
    media.port = DISCARD_PORT;

    // A transport projection replaces the complete ICE/DTLS ownership of the
    // m-section.  Keeping an already populated fingerprint here would make a
    // newly bundled m-line advertise the tag's ICE credentials but its old
    // transport's certificate.
    if (replaceDtls || !media.dtlsParams) {
      media.dtlsParams = dtlsTransport.localParameters;
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
        const establishedBundle = this.getEstablishedBundleGroup();
        const bundleMids = establishedBundle
          ? [
              ...establishedBundle.items.filter((mid) => mids.includes(mid)),
              ...mids.filter((mid) => !establishedBundle.items.includes(mid)),
            ]
          : mids;
        const bundle = new GroupDescription("BUNDLE", bundleMids);
        description.group.push(bundle);

        // A subsequent local offer may add new m-lines to an established
        // group before the answerer has accepted the migration.  Its SDP must
        // nevertheless advertise the established tag's ICE/DTLS properties;
        // the actual transceivers remain on their current transports until the
        // answer commits the pending graph.
        if (establishedBundle) {
          const tagTransport = this.getTransportForMid(
            bundleMids[0],
            transceivers,
            sctpTransport,
          );
          if (tagTransport) {
            description.media.forEach((media) => {
              if (media.rtp.muxId && bundleMids.includes(media.rtp.muxId)) {
                this.addTransportDescription(media, tagTransport, true);
              }
            });
          }
        }
      }
    }

    // RFC 8842 §5.5: association reuse still advertises setup:actpass.
    for (const media of description.media) {
      if (media.dtlsParams) {
        media.dtlsParams.role = "auto";
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
    dtlsTransportByMid,
    rejectedMids,
    sctpPort,
  }: {
    transceivers: RTCRtpTransceiver[];
    sctpTransport: RTCSctpTransport | undefined;

    signalingState: string;
    dtlsTransportByMid?: ReadonlyMap<string, RTCDtlsTransport>;
    rejectedMids?: ReadonlySet<string>;
    sctpPort?: number;
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

      if (["audio", "video"].includes(remoteMedia.kind)) {
        const transceiver = transceivers.find(
          (t) => t.mid === remoteMedia.rtp.muxId,
        );
        if (!transceiver) {
          throw new Error(
            `Transceiver with mid=${remoteMedia.rtp.muxId} not found`,
          );
        }
        dtlsTransport =
          dtlsTransportByMid?.get(remoteMedia.rtp.muxId ?? "") ??
          transceiver.dtlsTransport;
        media = this.createMediaDescriptionForTransceiver(
          transceiver,
          andDirection(transceiver.direction, transceiver.offerDirection),
          dtlsTransport,
        );
        if (remoteMedia.port === 0) {
          media.port = 0;
          media.msids = [];
        }
      } else if (remoteMedia.kind === "application") {
        if (!sctpTransport || !sctpTransport.mid) {
          throw new Error("sctpTransport not found");
        }
        dtlsTransport =
          dtlsTransportByMid?.get(remoteMedia.rtp.muxId ?? "") ??
          sctpTransport.dtlsTransport;
        media = this.createMediaDescriptionForSctp(
          sctpTransport,
          dtlsTransport,
          sctpPort,
        );
      } else {
        throw new Error("invalid kind");
      }

      const mid = media.rtp.muxId;
      if (rejectedMids && mid && rejectedMids.has(mid)) {
        media.port = 0;
        media.msids = [];
        if (media.kind === "application") {
          media.sctpPort = 0;
        }
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

    if (this.bundlePolicy !== "disable") {
      const acceptedMids = new Set(
        description.media
          .filter((media) => media.port !== 0)
          .map((media) => media.rtp.muxId)
          .filter((mid): mid is string => !!mid),
      );
      const remoteBundle = this.getRemoteBundleInfo(acceptedMids);
      if (remoteBundle) {
        // An answer accepts only the mids offered in the remote BUNDLE group
        // and preserves the offerer's selected tag as the first item.
        description.group.push(
          new GroupDescription("BUNDLE", remoteBundle.items),
        );
      }
    }

    return description;
  }

  setLocalDescription(description: SessionDescription, commit = true) {
    if (description.type === "offer" || description.type === "pranswer") {
      this.pendingLocalDescription = description;
      return;
    }

    this.pendingLocalDescription = description;
    if (!commit) {
      return;
    }

    this.commitPendingDescriptions();
  }

  /** Commit staged SDP only after the corresponding transport graph succeeds. */
  commitPendingDescriptions() {
    if (this.pendingLocalDescription) {
      this.currentLocalDescription = this.pendingLocalDescription;
    }
    if (this.pendingRemoteDescription) {
      this.currentRemoteDescription = this.pendingRemoteDescription;
    }
    this.pendingLocalDescription = undefined;
    this.pendingRemoteDescription = undefined;
  }

  /** Discard only a remote offer/answer that failed before graph commit. */
  discardPendingRemoteDescription() {
    this.pendingRemoteDescription = undefined;
  }

  /** Discard a local answer that failed before the SDP transaction committed. */
  discardPendingLocalDescription() {
    this.pendingLocalDescription = undefined;
  }

  private getTransportForMid(
    mid: string | undefined,
    transceivers: RTCRtpTransceiver[],
    sctpTransport?: RTCSctpTransport,
  ) {
    if (!mid) return undefined;
    const transceiver = transceivers.find((candidate) => candidate.mid === mid);
    if (transceiver) return transceiver.dtlsTransport;
    if (sctpTransport?.mid === mid) return sctpTransport.dtlsTransport;
    return undefined;
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

    if (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") {
      this.pendingRemoteDescription = remoteSdp;
    } else {
      // The answer is visible as pending until RTP/ICE/DTLS/SCTP validation
      // and any transport migration have completed in RTCPeerConnection.
      this.pendingRemoteDescription = remoteSdp;
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

  /**
   * Return the BUNDLE group from the description currently being applied.
   * Membership is intentionally kept separate from tag selection: during an
   * initial offer/answer exchange every m-section still owns its own ICE/DTLS
   * properties until the answer selects the group.
   * @internal
   */
  getRemoteBundleGroup() {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp || this.bundlePolicy === "disable") return undefined;
    return remoteSdp.group.find((group) => group.semantic === "BUNDLE");
  }

  /** @internal */
  getLocalBundleGroup() {
    const localSdp = this._localDescription;
    if (!localSdp || this.bundlePolicy === "disable") return undefined;
    return localSdp.group.find((group) => group.semantic === "BUNDLE");
  }

  /**
   * Return the negotiated BUNDLE membership, with the selected tag first.
   * The answer's group is authoritative for the accepted membership and tag:
   * an initial answer may promote a later offered MID when the suggested tag
   * was rejected.
   * @internal
   */
  getEstablishedBundleGroup() {
    if (this.bundlePolicy === "disable") return undefined;

    const local = this.currentLocalDescription;
    const remote = this.currentRemoteDescription;
    if (!local || !remote) return undefined;

    const offerGroup = (
      local.type === "offer"
        ? local
        : remote.type === "offer"
          ? remote
          : undefined
    )?.group.find((group) => group.semantic === "BUNDLE");
    const answerGroup = (
      local.type === "answer"
        ? local
        : remote.type === "answer"
          ? remote
          : undefined
    )?.group.find((group) => group.semantic === "BUNDLE");
    if (!offerGroup || !answerGroup) return undefined;

    const items = answerGroup.items.filter((mid) =>
      offerGroup.items.includes(mid),
    );
    if (items.length === 0) return undefined;
    return new GroupDescription("BUNDLE", items);
  }

  /**
   * BUNDLE is established only after both current descriptions contain a
   * common group. Pending offers/answers must not make the next candidate
   * route look established prematurely.
   * @internal
   */
  isBundleEstablished(): boolean {
    return !!this.getEstablishedBundleGroup();
  }

  get remoteIsBundled() {
    return this.getRemoteBundleInfo()?.group;
  }

  /**
   * Resolve the offerer's BUNDLE group and its first usable tag in one place.
   * Rejected m-sections cannot own the bundled transport, so the next item in
   * the offerer's preference order becomes the tag.
   * @internal
   */
  getRemoteBundleInfo(eligibleMids?: ReadonlySet<string>) {
    const remoteSdp = this._remoteDescription;
    const group = this.getRemoteBundleGroup();
    if (!remoteSdp || !group) return undefined;

    const items = group.items.filter((mid) => {
      const media = remoteSdp.media.find(
        (candidate) => candidate.rtp.muxId === mid,
      );
      return media?.port !== 0 && (eligibleMids?.has(mid) ?? true);
    });

    // For every remote offer, the offerer's first usable MID is the proposed
    // tag.  A subsequent offer is allowed to select a different tag; keeping
    // the old local tag here would discard the new tag's ICE/DTLS restart.
    const tag = items[0];
    if (!tag || !items.includes(tag)) return undefined;

    const orderedItems = [tag, ...items.filter((mid) => mid !== tag)];
    return { group, items: orderedItems, tag };
  }

  /**
   * ローカルセッション記述を設定し、トランスポート情報を追加する
   */
  setLocal(
    description: SessionDescription,
    transceivers: RTCRtpTransceiver[],
    sctpTransport?: { dtlsTransport: RTCDtlsTransport; mid?: string },
    options: {
      commit?: boolean;
      dtlsTransportByMid?: ReadonlyMap<string, RTCDtlsTransport>;
      replaceDtls?: boolean;
    } = {},
  ) {
    const transceiverByMLineIndex = new Map(
      transceivers.map((transceiver) => [transceiver?.mLineIndex, transceiver]),
    );
    const fallbackDtlsTransport =
      transceivers.find((transceiver) => transceiver?.dtlsTransport)
        ?.dtlsTransport ?? sctpTransport?.dtlsTransport;
    description.media
      .filter((m) => ["audio", "video"].includes(m.kind))
      .forEach((m, i) => {
        const mediaIndex = description.media.indexOf(m);
        const transceiver =
          transceiverByMLineIndex.get(mediaIndex) ?? transceivers[i];
        const dtlsTransport =
          options.dtlsTransportByMid?.get(m.rtp.muxId ?? "") ??
          transceiver?.dtlsTransport ??
          fallbackDtlsTransport;
        if (!dtlsTransport) {
          throw new Error(
            `dtls transport not found for media index ${mediaIndex}`,
          );
        }
        this.addTransportDescription(
          m,
          dtlsTransport,
          (options.replaceDtls ?? true) &&
            (options.dtlsTransportByMid?.has(m.rtp.muxId ?? "") ?? false),
        );
      });
    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (sctpTransport && sctpMedia) {
      this.addTransportDescription(
        sctpMedia,
        options.dtlsTransportByMid?.get(sctpMedia.rtp.muxId ?? "") ??
          sctpTransport.dtlsTransport,
        (options.replaceDtls ?? true) &&
          (options.dtlsTransportByMid?.has(sctpMedia.rtp.muxId ?? "") ?? false),
      );
    }

    // RFC 8842 §5.5: subsequent offers reuse the association with setup:actpass.
    // setLocal copies live localParameters (fixed role) for ICE/fingerprint
    // refresh, so restore actpass after that projection.
    if (description.type === "offer") {
      for (const media of description.media) {
        if (media.dtlsParams) {
          media.dtlsParams.role = "auto";
        }
      }
    }

    this.setLocalDescription(description, options.commit ?? true);
  }
}

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
