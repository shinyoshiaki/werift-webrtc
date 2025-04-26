import { DISCARD_HOST, DISCARD_PORT } from "./const";
import type { RTCRtpTransceiver } from "./media";
import { RTCRtpSimulcastParameters } from "./media/parameters";
import type { MediaDirection } from "./media/rtpTransceiver";
import {
  GroupDescription,
  MediaDescription,
  SessionDescription,
  SsrcDescription,
  addSDPHeader,
} from "./sdp";
import type { RTCDtlsTransport } from "./transport/dtls";
import { RTCSctpTransport } from "./transport/sctp";
import { andDirection } from "./utils";

/**
 * SDPに関連する処理を担当するクラス
 */
export class SDPHandler {
  private seenMid = new Set<string>();
  currentLocalDescription?: SessionDescription;
  currentRemoteDescription?: SessionDescription;
  pendingLocalDescription?: SessionDescription;
  pendingRemoteDescription?: SessionDescription;

  constructor(
    readonly cname: string,
    private midSuffix?: boolean,
    public bundlePolicy?: string,
  ) {}

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
    media.msid = transceiver.msid;
    media.rtp = {
      codecs: transceiver.codecs,
      headerExtensions: transceiver.headerExtensions,
      muxId: transceiver.mid,
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
    media.sctpCapabilities = RTCSctpTransport.getCapabilities();

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
      media.msid = undefined;
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
    const currentMedia = this.currentLocalDescription
      ? this.currentLocalDescription.media
      : [];

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
    transceivers
      .filter((t) => !description.media.find((m) => m.rtp.muxId === t.mid))
      .forEach((transceiver) => {
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
      });

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
        .map((m) => (m.direction !== "inactive" ? m.rtp.muxId : undefined))
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
  buildAnswerSdp(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
    remoteDescription: SessionDescription,
  ): SessionDescription {
    const description = new SessionDescription();
    addSDPHeader("answer", description);

    remoteDescription.media.forEach((remoteMedia) => {
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
        media = this.createMediaDescriptionForTransceiver(
          transceiver,
          andDirection(transceiver.direction, transceiver.offerDirection),
        );
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
    });

    if (this.bundlePolicy !== "disable") {
      const bundle = new GroupDescription("BUNDLE", []);
      for (const media of description.media) {
        if (media.direction !== "inactive") {
          bundle.items.push(media.rtp.muxId!);
        }
      }
      description.group.push(bundle);
    }

    return description;
  }

  /**
   * 既存のMIDを登録
   */
  registerMid(mid: string): void {
    this.seenMid.add(mid);
  }

  /**
   * 登録されているMIDをクリア
   */
  clearMids(): void {
    this.seenMid.clear();
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
}
