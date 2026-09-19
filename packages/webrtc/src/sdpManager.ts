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
  readonly mLineReuse: "compatible" | "aggressive";

  private seenMid = new Set<string>();

  constructor({
    cname,
    midSuffix,
    bundlePolicy,
    mLineReuse = "compatible",
  }: {
    cname: string;
    midSuffix?: boolean;
    bundlePolicy?: BundlePolicy;
    mLineReuse?: "compatible" | "aggressive";
  }) {
    this.cname = cname;
    this.midSuffix = midSuffix ?? false;
    this.bundlePolicy = bundlePolicy;
    this.mLineReuse = mLineReuse;
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
    fallbackFmt: MediaDescription["fmt"] = [],
    profile = "UDP/TLS/RTP/SAVPF",
    isOffer = false,
  ): MediaDescription {
    const rejected =
      transceiver.rejected ||
      transceiver.stopped ||
      (isOffer && transceiver.stopping) ||
      (this.mLineReuse === "aggressive" && direction === "inactive");
    const fmt =
      transceiver.codecs.length > 0
        ? transceiver.codecs.map((c) => c.payloadType)
        : fallbackFmt.length > 0
          ? fallbackFmt
          : [0];
    const media = new MediaDescription(
      transceiver.kind,
      rejected ? 0 : DISCARD_PORT,
      profile,
      fmt,
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

    this.addTransportDescription(media, transceiver.dtlsTransport, {
      rejected,
    });
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
    options: { rejected?: boolean } = {},
  ): void {
    const iceTransport = dtlsTransport.iceTransport;

    media.iceCandidates = iceTransport.localCandidates;
    media.iceCandidatesComplete = iceTransport.gatheringState === "complete";
    media.iceParams = iceTransport.localParameters;
    media.iceOptions = "trickle";

    media.host = DISCARD_HOST;
    // Codec / remote-port reject is distinct from direction=inactive.
    // Inactive sections keep a non-zero port and stay in BUNDLE so a browser
    // removeTrack renegotiation does not recycle the m-line out from under us.
    const rejectPort = options.rejected || media.port === 0;
    media.port = rejectPort ? 0 : DISCARD_PORT;

    if (media.direction === "inactive") {
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

    // # handle existing transceivers / sctp
    const currentMedia = this.currentLocalDescription?.media ?? [];

    // Only completed rejection is recyclable, not a stop awaiting its answer.
    for (const [i, media] of currentMedia.entries()) {
      const previous = transceivers.find((t) => t.mid === media.rtp.muxId);
      const remote = this.currentRemoteDescription?.media[i];
      if (
        !previous?.stopped ||
        !(
          media.port === 0 ||
          (remote?.port === 0 && remote.rtp.muxId === previous.mid)
        )
      )
        continue;
      const replacement = transceivers.find(
        (t) => !t.stopping && t.mid == null,
      );
      if (!replacement) continue;
      previous.mid = null;
      previous.mLineIndex = undefined;
      replacement.mLineIndex = i;
      replacement.mid = this.allocateMid(this.midSuffix ? "av" : "");
    }

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
        const transceiver =
          transceivers.find((t) => t.mid === mid) ??
          transceivers.find((t) => !t.stopping && t.mLineIndex === i);
        if (!transceiver) {
          if (m.port === 0 || m.direction === "inactive") {
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
            m.fmt,
            m.profile,
            true,
          ),
        );
      }
    });

    // # handle new transceivers / sctp
    for (const transceiver of transceivers.filter(
      (t) =>
        !t.stopping && !description.media.find((m) => m.rtp.muxId === t.mid),
    )) {
      if (transceiver.mid == undefined) {
        transceiver.mid = this.allocateMid(this.midSuffix ? "av" : "");
      }
      const mediaDescription = this.createMediaDescriptionForTransceiver(
        transceiver,
        transceiver.direction,
        [],
        "UDP/TLS/RTP/SAVPF",
        true,
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

    this.appendBundleGroup(description);

    return description;
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

    for (const remoteMedia of this._remoteDescription.media) {
      let dtlsTransport!: RTCDtlsTransport;
      let media: MediaDescription;

      if (["audio", "video"].includes(remoteMedia.kind)) {
        const mediaIndex = description.media.length;
        const transceiver =
          transceivers.find((t) => t.mid === remoteMedia.rtp.muxId) ??
          transceivers.find(
            (t) =>
              t.mLineIndex === mediaIndex &&
              (t.mid == null || t.mid === remoteMedia.rtp.muxId),
          );
        if (!transceiver) {
          throw new Error(
            `Transceiver with mid=${remoteMedia.rtp.muxId} not found`,
          );
        }
        media = this.createMediaDescriptionForTransceiver(
          transceiver,
          andDirection(transceiver.direction, transceiver.offerDirection),
          remoteMedia.fmt,
          remoteMedia.profile || "UDP/TLS/RTP/SAVPF",
        );
        if (transceiver.rejected) {
          if (remoteMedia.fmt.length > 0) {
            media.fmt = remoteMedia.fmt;
          }
          if (
            media.rtp.codecs.length === 0 &&
            remoteMedia.rtp.codecs.length > 0
          ) {
            media.rtp.codecs = remoteMedia.rtp.codecs;
          }
        }
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

    this.appendBundleGroup(description);

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

  private appendBundleGroup(description: SessionDescription) {
    if (this.bundlePolicy === "disable") {
      return;
    }
    const mids = description.media
      .filter((media) => media.port !== 0)
      .map((media) => media.rtp.muxId)
      .filter((mid): mid is string => !!mid);
    if (mids.length > 0) {
      description.group.push(new GroupDescription("BUNDLE", mids));
    }
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

  getBundleTaggedMedia(description?: SessionDescription): {
    media?: MediaDescription;
    sdpMLineIndex: number;
  } {
    const target = description ?? this._localDescription;
    if (!target?.media.length) {
      return { sdpMLineIndex: 0 };
    }

    const bundle = target.group.find((g) => g.semantic === "BUNDLE");
    const tag = bundle?.items[0];
    if (tag) {
      const sdpMLineIndex = target.media.findIndex(
        (media) => media.rtp.muxId === tag,
      );
      if (sdpMLineIndex >= 0) {
        return { media: target.media[sdpMLineIndex], sdpMLineIndex };
      }
    }

    const acceptedIndex = target.media.findIndex((media) => media.port !== 0);
    if (acceptedIndex >= 0) {
      return {
        media: target.media[acceptedIndex],
        sdpMLineIndex: acceptedIndex,
      };
    }

    return { media: target.media[0], sdpMLineIndex: 0 };
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
    description.media.forEach((m, i) => {
      if (!["audio", "video"].includes(m.kind)) return;
      const transceiver =
        transceivers.find((t) => t.mid != null && t.mid === m.rtp.muxId) ??
        transceiverByMLineIndex.get(i) ??
        transceivers[i];
      const dtlsTransport = transceiver?.dtlsTransport ?? fallbackDtlsTransport;
      if (!dtlsTransport) {
        throw new Error(`dtls transport not found for media index ${i}`);
      }
      this.addTransportDescription(m, dtlsTransport, {
        rejected: transceiver?.rejected,
      });
    });
    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (sctpTransport && sctpMedia) {
      this.addTransportDescription(sctpMedia, sctpTransport.dtlsTransport);
    }

    this.setLocalDescription(description);
  }
}

export interface RTCSessionDescriptionInit {
  sdp?: string;
  type?: RTCSdpType;
}
export type RTCSdpType = "answer" | "offer" | "pranswer" | "rollback";
