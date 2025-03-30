import { enumerate } from "../../helper";
import { debug } from "../../imports/common";
import type { RTCRtpCodecParameters, RTCRtpTransceiver } from "../../media";
import {
  GroupDescription,
  type MediaDescription,
  SessionDescription,
  addSDPHeader,
} from "../../sdp";
import type { RTCDtlsTransport } from "../../transport/dtls";
import type { RTCSctpTransport } from "../../transport/sctp";
import { andDirection, reverseSimulcastDirection } from "../../utils";
import type { PeerConfig } from "../util";
import {
  addTransportDescription,
  allocateMid,
  assertDescription,
  assertSignalingState,
  assignTransceiverCodecs,
  createMediaDescriptionForSctp,
  createMediaDescriptionForTransceiver,
} from "../util";
import type { RTCSignalingState } from "./stateManager";

const log = debug("werift:webrtc/sdpManager");

/**
 * SDPマネージャー
 * セッション記述プロトコル (SDP) に関連する処理を担当
 */
export class SdpManager {
  private currentLocalDescription?: SessionDescription;
  private currentRemoteDescription?: SessionDescription;
  private pendingLocalDescription?: SessionDescription;
  private pendingRemoteDescription?: SessionDescription;
  private seenMid = new Set<string>();

  constructor() {}

  /**
   * オファーSDPを構築する
   */
  buildOfferSdp(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
    config: Required<PeerConfig>,
    cname: string,
    getTransceiverByMid: (mid: string) => RTCRtpTransceiver | undefined,
  ) {
    // コーデックとヘッダー拡張の設定
    transceivers.forEach((transceiver) => {
      if (transceiver.codecs.length === 0) {
        assignTransceiverCodecs(
          transceiver,
          config.codecs[transceiver.kind] as RTCRtpCodecParameters[],
        );
      }
      if (transceiver.headerExtensions.length === 0) {
        transceiver.headerExtensions =
          config.headerExtensions[transceiver.kind] ?? [];
      }
    });

    const description = new SessionDescription();
    addSDPHeader("offer", description);

    // 既存のトランシーバー/SCTPの処理
    const currentMedia = this._localDescription
      ? this._localDescription.media
      : [];

    currentMedia.forEach((m, i) => {
      const mid = m.rtp.muxId;
      if (!mid) {
        log("mid missing", m);
        return;
      }
      if (m.kind === "application") {
        if (!sctpTransport) {
          throw new Error("sctpTransport not found");
        }
        sctpTransport.mLineIndex = i;
        description.media.push(createMediaDescriptionForSctp(sctpTransport));
      } else {
        const transceiver = getTransceiverByMid(mid);
        if (!transceiver) {
          if (m.direction === "inactive") {
            description.media.push(m);
            return;
          }
          throw new Error("transceiver not found");
        }
        transceiver.mLineIndex = i;
        description.media.push(
          createMediaDescriptionForTransceiver(
            transceiver,
            cname,
            transceiver.direction,
          ),
        );
      }
    });

    // 新しいトランシーバー/SCTPの処理
    transceivers
      .filter((t) => !description.media.find((m) => m.rtp.muxId === t.mid))
      .forEach((transceiver) => {
        if (transceiver.mid == undefined) {
          transceiver.mid = allocateMid(
            this.seenMid,
            config.midSuffix ? "av" : "",
          );
        }
        const mediaDescription = createMediaDescriptionForTransceiver(
          transceiver,
          cname,
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
        sctpTransport.mid = allocateMid(
          this.seenMid,
          config.midSuffix ? "dc" : "",
        );
      }
      description.media.push(createMediaDescriptionForSctp(sctpTransport));
    }

    // BUNDLEポリシーの設定
    if (config.bundlePolicy !== "disable") {
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
   * アンサーSDPを構築する
   */
  buildAnswer(
    transceivers: RTCRtpTransceiver[],
    sctpTransport: RTCSctpTransport | undefined,
    signalingState: string,
    cname: string,
    config: Required<PeerConfig>,
    getTransceiverByMid: (mid: string) => RTCRtpTransceiver | undefined,
  ) {
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
      const { dtlsTransport, media } = (() => {
        if (["audio", "video"].includes(remoteMedia.kind)) {
          const transceiver = getTransceiverByMid(remoteMedia.rtp.muxId!)!;
          const media = createMediaDescriptionForTransceiver(
            transceiver,
            cname,
            andDirection(transceiver.direction, transceiver.offerDirection),
          );
          return { dtlsTransport: transceiver.dtlsTransport, media };
        } else if (remoteMedia.kind === "application") {
          if (!sctpTransport || !sctpTransport.mid) {
            throw new Error("sctpTransport not found");
          }
          const media = createMediaDescriptionForSctp(sctpTransport);

          return { dtlsTransport: sctpTransport.dtlsTransport, media };
        } else {
          throw new Error("invalid kind");
        }
      })();

      // DTLSロールの決定
      if (media.dtlsParams) {
        if (dtlsTransport.role === "auto") {
          media.dtlsParams.role = "client";
        } else {
          media.dtlsParams.role = dtlsTransport.role;
        }
      }

      media.simulcastParameters = remoteMedia.simulcastParameters.map((v) => ({
        ...v,
        direction: reverseSimulcastDirection(v.direction),
      }));

      description.media.push(media);
    }

    // BUNDLEポリシーの設定
    if (config.bundlePolicy !== "disable") {
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
   * ローカル説明を設定する
   */
  setLocal(
    description: SessionDescription,
    transceivers: RTCRtpTransceiver[],
    sctpTransport?: RTCSctpTransport,
  ) {
    description.media
      .filter((m) => ["audio", "video"].includes(m.kind))
      .forEach((m, i) => {
        addTransportDescription(m, transceivers[i].dtlsTransport);
      });

    const sctpMedia = description.media.find((m) => m.kind === "application");
    if (sctpTransport && sctpMedia) {
      addTransportDescription(sctpMedia, sctpTransport.dtlsTransport);
    }

    if (description.type === "answer") {
      this.currentLocalDescription = description;
      this.pendingLocalDescription = undefined;
    } else {
      this.pendingLocalDescription = description;
    }
  }

  /**
   * 説明の検証
   */
  assertSdpDescription(
    description: SessionDescription,
    isLocal: boolean,
    signalingState: RTCSignalingState,
  ) {
    assertSignalingState(description, signalingState, isLocal);
    const offer = isLocal ? this._remoteDescription : this._localDescription;
    assertDescription({
      description,
      offer,
    });
  }

  /**
   * リモート説明の処理
   */
  processRemoteDescription(remoteSdp: SessionDescription) {
    if (remoteSdp.type === "answer") {
      this.currentRemoteDescription = remoteSdp;
      this.pendingRemoteDescription = undefined;
    } else {
      this.pendingRemoteDescription = remoteSdp;
    }
  }

  /**
   * MID値をキャプチャ
   */
  captureMids(description: SessionDescription) {
    for (const [, media] of enumerate(description.media)) {
      const mid = media.rtp.muxId!;
      this.seenMid.add(mid);
    }
  }

  /**
   * ローカル記述の取得
   * @private
   */
  get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  /**
   * リモート記述の取得
   * @private
   */
  get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
  }

  /**
   * ローカル記述のJSON表現を取得
   */
  get localDescription() {
    if (!this._localDescription) {
      return undefined;
    }
    return this._localDescription.toJSON();
  }

  /**
   * リモート記述のJSON表現を取得
   */
  get remoteDescription() {
    if (!this._remoteDescription) {
      return undefined;
    }
    return this._remoteDescription.toJSON();
  }

  /**
   * リモートがバンドルされているか判定
   */
  isRemoteBundled(bundlePolicy: string) {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp) {
      return undefined;
    }
    const bundle = remoteSdp.group.find(
      (g) => g.semantic === "BUNDLE" && bundlePolicy !== "disable",
    );
    return bundle;
  }

  /**
   * DTOとして状態をエクスポート (マイグレーション対応)
   */
  toJSON() {
    return {
      currentLocalDescription: this.currentLocalDescription,
      currentRemoteDescription: this.currentRemoteDescription,
      pendingLocalDescription: this.pendingLocalDescription,
      pendingRemoteDescription: this.pendingRemoteDescription,
      seenMid: Array.from(this.seenMid),
    };
  }

  /**
   * JSONからstateをリストア (マイグレーション対応)
   */
  fromJSON(json: any) {
    if (json.currentLocalDescription) {
      this.currentLocalDescription = json.currentLocalDescription;
    }
    if (json.currentRemoteDescription) {
      this.currentRemoteDescription = json.currentRemoteDescription;
    }
    if (json.pendingLocalDescription) {
      this.pendingLocalDescription = json.pendingLocalDescription;
    }
    if (json.pendingRemoteDescription) {
      this.pendingRemoteDescription = json.pendingRemoteDescription;
    }
    if (json.seenMid) {
      this.seenMid = new Set(json.seenMid);
    }
  }
}
