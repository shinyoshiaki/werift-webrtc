import { SRTP_PROFILE } from "../const";
import { Event, debug } from "../imports/common";
import type {
  RTCRtpTransceiver,
  RtpRouter,
  TransceiverManager,
} from "../media";
import type { PeerConfig } from "../peerConnection";
import type { BundlePolicy, SessionDescription } from "../sdp";
import type { ConnectionState } from "../types/domain";
import { parseIceServers } from "../utils";
import { type DtlsKeys, RTCCertificate, RTCDtlsTransport } from "./dtls";
import { IceCandidate, RTCIceGatherer, RTCIceTransport } from "./ice";
import type {
  IceGathererState,
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceConnectionState,
} from "./ice";
import type { RTCSctpTransport } from "./sctp";
import type { SctpTransportHandler } from "./sctpManager";

const log = debug(
  "werift:packages/webrtc/src/transport/secureTransportManager.ts",
);
export class SecureTransportHandler {
  connectionState: ConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: IceGathererState = "new";
  certificate?: RTCCertificate;

  readonly iceGatheringStateChange = new Event<[IceGathererState]>();
  readonly iceConnectionStateChange = new Event<[RTCIceConnectionState]>();
  readonly onIceCandidate = new Event<[IceCandidate | undefined]>();
  readonly connectionStateChange = new Event<[ConnectionState]>();
  private config: PeerConfig;
  private transceiverManager: TransceiverManager;
  private sctpHandler: SctpTransportHandler;
  private router: RtpRouter;

  constructor({
    config,
    transceiverManager,
    sctpHandler,
    router,
  }: {
    config: PeerConfig;
    transceiverManager: TransceiverManager;
    sctpHandler: SctpTransportHandler;
    router: RtpRouter;
  }) {
    this.config = config;
    this.transceiverManager = transceiverManager;
    this.sctpHandler = sctpHandler;
    this.router = router;

    if (this.config.dtls) {
      const { keys } = this.config.dtls;

      if (keys) {
        this.setupCertificate(keys);
      }
    }
  }

  get dtlsTransports() {
    const transports = this.transceiverManager
      .getTransceivers()
      .map((t) => t.dtlsTransport);
    if (this.sctpHandler.sctpTransport) {
      transports.push(this.sctpHandler.sctpTransport.dtlsTransport);
    }
    return transports.reduce((acc: RTCDtlsTransport[], cur) => {
      if (!acc.map((d) => d.id).includes(cur.id)) {
        acc.push(cur);
      }
      return acc;
    }, []);
  }

  get iceTransports() {
    return this.dtlsTransports.map((d) => d.iceTransport);
  }

  setupCertificate(keys: DtlsKeys) {
    this.certificate = new RTCCertificate(
      keys.keyPem,
      keys.certPem,
      keys.signatureHash,
    );
  }

  createTransport() {
    const [existing] = this.iceTransports;

    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(this.config.iceServers),
      forceTurn: this.config.iceTransportPolicy === "relay",
      portRange: this.config.icePortRange,
      interfaceAddresses: this.config.iceInterfaceAddresses,
      additionalHostAddresses: this.config.iceAdditionalHostAddresses,
      filterStunResponse: this.config.iceFilterStunResponse,
      filterCandidatePair: this.config.iceFilterCandidatePair,
      localPasswordPrefix: this.config.icePasswordPrefix,
      useIpv4: this.config.iceUseIpv4,
      useIpv6: this.config.iceUseIpv6,
      turnTransport: this.config.forceTurnTCP === true ? "tcp" : "udp",
      useLinkLocalAddress: this.config.iceUseLinkLocalAddress,
    });

    if (existing) {
      iceGatherer.connection.localUsername = existing.connection.localUsername;
      iceGatherer.connection.localPassword = existing.connection.localPassword;
    }

    iceGatherer.onGatheringStateChange.subscribe(() => {
      this.updateIceGatheringState();
    });
    this.updateIceGatheringState();

    const iceTransport = new RTCIceTransport(iceGatherer);
    this.iceTransports.push(iceTransport);
    iceTransport.onStateChange.subscribe(() => {
      this.updateIceConnectionState();
    });

    const dtlsTransport = new RTCDtlsTransport(
      this.config,
      iceTransport,
      this.router,
      this.certificate,
      srtpProfiles,
    );

    return dtlsTransport;
  }

  handleNewIceCandidate({
    candidate,
    localDescription,
    remoteIsBundled,
    transceiver,
    sctpTransport,
    bundlePolicy,
  }: {
    candidate: IceCandidate;
    localDescription?: SessionDescription;
    remoteIsBundled: boolean;
    transceiver?: RTCRtpTransceiver;
    sctpTransport?: RTCSctpTransport;
    bundlePolicy?: BundlePolicy;
  }) {
    if (!localDescription) {
      log("localDescription not found when ice candidate was gathered");
      return;
    }

    // Assign sdpMid and sdpMLineIndex
    if (bundlePolicy === "max-bundle" || remoteIsBundled) {
      candidate.sdpMLineIndex = 0;
      const media = localDescription?.media[0];
      if (media) {
        candidate.sdpMid = media.rtp.muxId;
      }
    } else {
      if (transceiver) {
        candidate.sdpMLineIndex = transceiver.mLineIndex;
        candidate.sdpMid = transceiver.mid;
      }
      if (sctpTransport) {
        candidate.sdpMLineIndex = sctpTransport.mLineIndex;
        candidate.sdpMid = sctpTransport.mid;
      }
    }

    if (
      candidate.foundation &&
      !candidate.foundation.startsWith("candidate:")
    ) {
      candidate.foundation = "candidate:" + candidate.foundation;
    }

    this.onIceCandidate.execute(candidate);

    return candidate;
  }

  async addIceCandidate(
    sdp: SessionDescription,
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit,
  ) {
    const candidate = IceCandidate.fromJSON(candidateMessage);
    if (!candidate) {
      return;
    }

    let iceTransport: RTCIceTransport | undefined;

    if (typeof candidate.sdpMid === "number") {
      iceTransport = this.getTransportByMid(candidate.sdpMid);
    }

    if (!iceTransport && typeof candidate.sdpMLineIndex === "number") {
      iceTransport = this.getTransportByMLineIndex(
        sdp,
        candidate.sdpMLineIndex,
      );
    }

    if (!iceTransport) {
      iceTransport = this.iceTransports[0];
    }

    if (iceTransport) {
      await iceTransport.addRemoteCandidate(candidate);
    } else {
      log("iceTransport not found for candidate", candidate);
    }
  }

  private getTransportByMid(mid: string) {
    let iceTransport: RTCIceTransport | undefined;

    const transceiver = this.transceiverManager
      .getTransceivers()
      .find((t) => t.mid === mid);
    if (transceiver) {
      iceTransport = transceiver.dtlsTransport.iceTransport;
    } else if (!iceTransport && this.sctpHandler.sctpTransport?.mid === mid) {
      iceTransport = this.sctpHandler.sctpTransport.dtlsTransport.iceTransport;
    }

    return iceTransport;
  }

  private getTransportByMLineIndex(sdp: SessionDescription, index: number) {
    const media = sdp.media[index];
    if (!media) {
      return;
    }
    const transport = this.getTransportByMid(media.rtp.muxId!);

    return transport;
  }

  restartIce() {
    for (const transport of this.iceTransports) {
      transport.restart();
    }
  }

  setLocalRole({
    type,
    role,
  }: {
    type: "offer" | "answer";
    role: "auto" | "client" | "server" | undefined;
  }) {
    for (const dtlsTransport of this.dtlsTransports) {
      const iceTransport = dtlsTransport.iceTransport;
      if (type === "offer") {
        iceTransport.connection.iceControlling = true;
      } else {
        iceTransport.connection.iceControlling = false;
      }
      // RFC 8445 S6.1.1
      if (iceTransport.connection.remoteIsLite) {
        iceTransport.connection.iceControlling = true;
      }

      // # set DTLS role for mediasoup
      if (type === "answer") {
        if (role) {
          dtlsTransport.role = role;
        }
      }
    }
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtcicegatheringstate
  private updateIceGatheringState() {
    const all = this.iceTransports;

    function allMatch(...state: IceGathererState[]) {
      return (
        all.filter((check) => state.includes(check.gatheringState)).length ===
        all.length
      );
    }

    let newState: IceGathererState;

    if (all.length && allMatch("complete")) {
      newState = "complete";
    } else if (!all.length || allMatch("new", "complete")) {
      newState = "new";
    } else if (all.map((check) => check.gatheringState).includes("gathering")) {
      newState = "gathering";
    } else {
      newState = "new";
    }

    if (this.iceGatheringState === newState) {
      return;
    }

    this.iceGatheringState = newState;
    this.iceGatheringStateChange.execute(newState);
  }

  // https://w3c.github.io/webrtc-pc/#dom-rtciceconnectionstate
  updateIceConnectionState() {
    const all = this.iceTransports;
    let newState: RTCIceConnectionState;

    function allMatch(...state: RTCIceConnectionState[]) {
      return (
        all.filter((check) => state.includes(check.state)).length === all.length
      );
    }

    if (this.connectionState === "closed") {
      newState = "closed";
    } else if (allMatch("failed")) {
      newState = "failed";
    } else if (allMatch("disconnected")) {
      newState = "disconnected";
    } else if (allMatch("new", "closed")) {
      newState = "new";
    } else if (allMatch("new", "checking")) {
      newState = "checking";
    } else if (allMatch("completed", "closed")) {
      newState = "completed";
    } else if (allMatch("connected", "completed", "closed")) {
      newState = "connected";
    } else {
      // unreachable?
      newState = "new";
    }

    if (this.iceConnectionState === newState) {
      return;
    }

    log("iceConnectionStateChange", newState);
    this.iceConnectionState = newState;
    this.iceConnectionStateChange.execute(newState);
  }

  async stop() {
    await Promise.allSettled([...this.iceTransports.map((t) => t.stop())]);
    // イベントリスナーなどもここで解除
    this.iceGatheringStateChange.allUnsubscribe();
    this.iceConnectionStateChange.allUnsubscribe();
    this.onIceCandidate.allUnsubscribe();
  }

  async gatherCandidates(remoteIsBundled: boolean) {
    const connected = this.iceTransports.find(
      (transport) =>
        transport.state === "connected" || transport.state === "completed",
    );
    if (remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
      log("skipping ICE gathering for bundled connection");
    } else {
      await Promise.allSettled(
        this.iceTransports.map((iceTransport) => iceTransport.gather()),
      ).catch((e) => {
        // エラーハンドリングを追加 (例: ログ出力)
        log("gatherCandidates failed", e);
      });
    }
  }

  setConnectionState(state: ConnectionState) {
    log("connectionStateChange", state);
    this.connectionState = state;
    this.connectionStateChange.execute(state);
  }

  async ensureCerts() {
    if (!this.certificate) {
      this.certificate = await RTCDtlsTransport.SetupCertificate();
    }

    for (const dtlsTransport of this.dtlsTransports) {
      dtlsTransport.localCertificate = this.certificate;
    }
  }
}

const srtpProfiles = [
  SRTP_PROFILE.SRTP_AEAD_AES_128_GCM, // prefer
  SRTP_PROFILE.SRTP_AES128_CM_HMAC_SHA1_80,
];
