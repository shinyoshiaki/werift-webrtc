import { randomUUID } from "node:crypto";
import cloneDeep from "lodash/cloneDeep.js";
import { EventTarget } from "../helper";
import { debug } from "../imports/common";
import {
  type RTCRtpTransceiver,
  RtpRouter,
  useOPUS,
  usePCMU,
  useVP8,
} from "../media";
import type { SessionDescription } from "../sdp";
import type { RTCCertificate, RTCDtlsTransport } from "../transport/dtls";
import type { RTCIceTransport } from "../transport/ice";
import type { RTCSctpTransport } from "../transport/sctp";
import { DtlsManager } from "./managers/dtlsManager";
import { IceManager } from "./managers/iceManager";
import { MediaManager } from "./managers/mediaManager";
import { SctpManager } from "./managers/sctpManager";
import { SdpManager } from "./managers/sdpManager";
import {
  type ConnectionState,
  type RTCSignalingState,
  StateManager,
} from "./managers/stateManager";
import type { PeerConfig } from "./util";

const log = debug("werift:packages/webrtc/src/pc/peerConnectionContext.ts");

export class RTCPeerConnectionContext extends EventTarget {
  readonly cname = randomUUID();
  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig);
  negotiationneeded = false;
  protected isClosed = false;
  protected shouldNegotiationneeded = false;
  protected readonly router = new RtpRouter();

  // Manager instances
  protected readonly stateManager = new StateManager();
  protected readonly sdpManager = new SdpManager();
  protected readonly iceManager = new IceManager();
  protected readonly dtlsManager = new DtlsManager();
  protected readonly sctpManager = new SctpManager();
  protected readonly mediaManager: MediaManager;

  // Events
  readonly iceGatheringStateChange = this.stateManager.iceGatheringStateChange;
  readonly iceConnectionStateChange =
    this.stateManager.iceConnectionStateChange;
  readonly signalingStateChange = this.stateManager.signalingStateChange;
  readonly connectionStateChange = this.stateManager.connectionStateChange;
  readonly onTrack = this.mediaManager.onTrack;
  readonly onTransceiverAdded = this.mediaManager.onTransceiverAdded;
  readonly onRemoteTransceiverAdded =
    this.mediaManager.onRemoteTransceiverAdded;
  readonly onDataChannel = this.sctpManager.onDataChannel;

  constructor() {
    super();
    this.mediaManager = new MediaManager(this.config);

    // Setup event relationships between managers
    this.setupManagerRelationships();
  }

  /**
   * Setup relationships and event handlers between managers
   */
  private setupManagerRelationships() {
    // When ICE transport state changes, update the connection states
    this.iceConnectionStateChange.subscribe(() => {
      this.updateConnectionState();
    });
  }

  /**
   * Get all DTLS transports
   */
  get dtlsTransports() {
    return this.dtlsManager.getAllDtlsTransports();
  }

  /**
   * Get all ICE transports
   */
  get iceTransports() {
    return this.iceManager.getAllIceTransports();
  }

  /**
   * Get the current connection state
   */
  get connectionState() {
    return this.stateManager.connectionState;
  }

  /**
   * Get the current ICE connection state
   */
  get iceConnectionState() {
    return this.stateManager.iceConnectionState;
  }

  /**
   * Get the current ICE gathering state
   */
  get iceGatheringState() {
    return this.stateManager.iceGatheringState;
  }

  /**
   * Get the current signaling state
   */
  get signalingState() {
    return this.stateManager.signalingState;
  }

  /**
   * Get the current local description (private)
   * @private
   */
  get _localDescription() {
    return this.sdpManager._localDescription;
  }

  /**
   * Get the current remote description (private)
   * @private
   */
  get _remoteDescription() {
    return this.sdpManager._remoteDescription;
  }

  /**
   * Get the current local description (for external use)
   */
  get localDescription() {
    return this.sdpManager.localDescription;
  }

  /**
   * Get the current remote description (for external use)
   */
  get remoteDescription() {
    return this.sdpManager.remoteDescription;
  }

  /**
   * Check if remote endpoint is using bundle
   */
  get remoteIsBundled() {
    return this.sdpManager.isRemoteBundled(this.config.bundlePolicy);
  }

  /**
   * Get the current SCTP transport
   */
  get sctpTransport() {
    return this.sctpManager.getSctpTransport();
  }

  /**
   * Get the SCTP remote port
   */
  get sctpRemotePort() {
    return this.sctpManager.getRemotePort();
  }

  /**
   * Check if ICE restart is needed
   */
  get needRestart() {
    return this.iceManager.isRestartRequired();
  }

  /**
   * Set ICE restart flag
   */
  set needRestart(value: boolean) {
    if (value) {
      this.iceManager.restartIce();
    } else {
      this.iceManager.clearRestartFlag();
    }
  }

  /**
   * Get all transceivers
   */
  get transceivers() {
    return this.mediaManager.getTransceivers();
  }

  /**
   * Build an offer SDP
   */
  protected buildOfferSdp() {
    return this.sdpManager.buildOfferSdp(
      this.transceivers,
      this.sctpTransport,
      this.config,
      this.cname,
      this.getTransceiverByMid.bind(this),
    );
  }

  /**
   * Build an answer SDP
   */
  protected buildAnswer() {
    this.assertNotClosed();

    return this.sdpManager.buildAnswer(
      this.transceivers,
      this.sctpTransport,
      this.signalingState,
      this.cname,
      this.config,
      this.getTransceiverByMid.bind(this),
    );
  }

  /**
   * Set the local description
   */
  protected setLocal(description: SessionDescription) {
    this.sdpManager.setLocal(
      description,
      this.transceivers,
      this.sctpTransport,
    );
  }

  /**
   * Process a remote description
   */
  protected processRemoteDescription(remoteSdp: SessionDescription) {
    this.sdpManager.processRemoteDescription(remoteSdp);
  }

  /**
   * Assert a valid SDP description
   */
  protected assertSdpDescription(
    description: SessionDescription,
    isLocal: boolean,
  ) {
    this.sdpManager.assertSdpDescription(
      description,
      isLocal,
      this.signalingState,
    );
  }

  /**
   * Capture MIDs from a description
   */
  protected captureMids(description: SessionDescription) {
    this.sdpManager.captureMids(description);
  }

  /**
   * Add a transceiver
   */
  protected addTransceiver(trackOrKind: any, options: any = {}) {
    // Create a transport if needed
    const dtlsTransport = this.createTransport([]);
    return this.mediaManager.addTransceiver(
      trackOrKind,
      dtlsTransport,
      options,
    );
  }

  /**
   * Add a track
   */
  protected addTrack(track: any, stream: any) {
    const dtlsTransport = this.createTransport([]);
    return this.mediaManager.addTrack(track, dtlsTransport, [stream]);
  }

  /**
   * Remove a track
   */
  protected removeTrack(sender: any) {
    return this.mediaManager.removeTrack(sender);
  }

  /**
   * Create a data channel
   */
  protected createDataChannel(label: string, options: any = {}) {
    // Create SCTP transport if it doesn't exist
    if (!this.sctpTransport) {
      const dtlsTransport = this.createTransport([]);
      this.sctpManager.createSctpTransport(dtlsTransport);
      this.needNegotiation();
    }

    return this.sctpManager.createDataChannel(label, options);
  }

  /**
   * Get a transceiver by MID
   */
  protected getTransceiverByMid(mid: string) {
    return this.mediaManager.getTransceiverByMid(mid);
  }

  /**
   * Get a transceiver by mLineIndex
   */
  protected getTransceiverByMLineIndex(index: number) {
    return this.mediaManager.getTransceiverByMLineIndex(index);
  }

  /**
   * Get an ICE transport by MID
   */
  protected getTransportByMid(mid: string) {
    let iceTransport: RTCIceTransport | undefined;

    const transceiver = this.getTransceiverByMid(mid);
    if (transceiver) {
      iceTransport = transceiver.dtlsTransport.iceTransport;
    } else if (!iceTransport && this.sctpTransport?.mid === mid) {
      iceTransport = this.sctpTransport?.dtlsTransport.iceTransport;
    }

    return iceTransport;
  }

  /**
   * Get an ICE transport by mLineIndex
   */
  protected getTransportByMLineIndex(sdp: SessionDescription, index: number) {
    const media = sdp.media[index];
    if (!media) {
      return;
    }
    const transport = this.getTransportByMid(media.rtp.muxId!);

    return transport;
  }

  /**
   * Create a new transport
   */
  protected createTransport(srtpProfiles: any[] = []) {
    // Get existing transport if there is one
    const existingTransport = this.iceTransports[0];

    // Create ICE transport
    const iceTransport = this.iceManager.createIceTransport(
      this.config,
      this.config.bundlePolicy,
      existingTransport,
    );

    // Set up ICE transport event listeners
    iceTransport.onStateChange.subscribe(() => {
      this.updateIceConnectionState();
    });

    iceTransport.onGatheringStateChange.subscribe(() => {
      this.updateIceGatheringState();
    });

    iceTransport.onNegotiationNeeded.subscribe(() => {
      this.needNegotiation();
    });

    // Create DTLS transport
    const dtlsTransport = this.dtlsManager.createDtlsTransport(
      this.config,
      iceTransport,
      this.router,
      srtpProfiles,
    );

    return dtlsTransport;
  }

  /**
   * Set the signaling state
   */
  protected setSignalingState(state: RTCSignalingState) {
    this.stateManager.setSignalingState(state);
  }

  /**
   * Set the connection state
   */
  protected setConnectionState(state: ConnectionState) {
    this.stateManager.setConnectionState(state);
  }

  /**
   * Update the ICE gathering state
   */
  protected updateIceGatheringState() {
    const newState = this.iceManager.getIceGatheringState();
    this.stateManager.updateIceGatheringState(newState);
  }

  /**
   * Update the ICE connection state
   */
  protected updateIceConnectionState() {
    const newState = this.iceManager.getIceConnectionState(
      this.connectionState,
    );
    this.stateManager.updateIceConnectionState(newState);
  }

  /**
   * Update the connection state based on ICE and DTLS states
   */
  protected updateConnectionState() {
    // This could be extended with more sophisticated logic
    if (this.iceConnectionState === "failed") {
      this.setConnectionState("failed");
    } else if (this.iceConnectionState === "disconnected") {
      this.setConnectionState("disconnected");
    } else if (this.iceConnectionState === "connected") {
      this.setConnectionState("connected");
    }
  }

  /**
   * Gather ICE candidates
   */
  protected async gatherCandidates() {
    await this.iceManager.gatherCandidates(this.remoteIsBundled);
  }

  /**
   * Connect transports
   */
  protected async connect() {
    log("start connect");

    try {
      // Start ICE transports
      await this.iceManager.startAllIceTransports();

      // Start DTLS transports
      await this.dtlsManager.startAllDtlsTransports();

      // Start SCTP transport if needed
      if (this.sctpTransport && this.sctpRemotePort) {
        await this.sctpManager.startSctpTransport();
      }

      this.setConnectionState("connected");
    } catch (error) {
      log("connect failed", error);
      this.setConnectionState("failed");
    }
  }

  /**
   * Signal that negotiation is needed
   */
  protected needNegotiation() {
    this.shouldNegotiationneeded = true;
    if (this.negotiationneeded || this.signalingState !== "stable") {
      return;
    }
    this.shouldNegotiationneeded = false;
    setImmediate(() => {
      this.negotiationneeded = true;
      this.onNegotiationNeeded();
    });
  }

  /**
   * Handle negotiation needed event - to be overridden by child classes
   */
  protected onNegotiationNeeded() {
    // To be overridden
  }

  /**
   * Assert that connection is not closed
   */
  protected assertNotClosed() {
    if (this.isClosed) {
      throw new Error("RTCPeerConnection is closed");
    }
  }

  /**
   * Close the connection
   */
  protected async close() {
    if (this.isClosed) return;

    this.isClosed = true;
    this.setSignalingState("closed");
    this.setConnectionState("closed");

    // Stop all transceivers
    this.mediaManager.stopAllTransceivers();

    // Stop SCTP transport
    await this.sctpManager.stopSctpTransport();

    // Stop DTLS transports
    await this.dtlsManager.stopAllTransports();

    // Stop ICE transports
    await this.iceManager.stopAllTransports();

    log("peerConnection closed");
  }

  /**
   * Serialize to JSON for live migration
   */
  toJSON() {
    return {
      cname: this.cname,
      config: this.config,
      negotiationneeded: this.negotiationneeded,
      isClosed: this.isClosed,
      shouldNegotiationneeded: this.shouldNegotiationneeded,
      sdpManager: this.sdpManager.toJSON(),
      iceManager: this.iceManager.toJSON(),
      dtlsManager: this.dtlsManager.toJSON(),
      sctpManager: this.sctpManager.toJSON(),
      mediaManager: this.mediaManager.toJSON(),
      stateManager: {
        connectionState: this.connectionState,
        iceConnectionState: this.iceConnectionState,
        iceGatheringState: this.iceGatheringState,
        signalingState: this.signalingState,
      },
    };
  }
}

export const defaultPeerConfig: PeerConfig = {
  codecs: {
    audio: [useOPUS(), usePCMU()],
    video: [useVP8()],
  },
  headerExtensions: {
    audio: [],
    video: [],
  },
  iceTransportPolicy: "all",
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  icePortRange: undefined,
  iceInterfaceAddresses: undefined,
  iceAdditionalHostAddresses: undefined,
  iceUseIpv4: true,
  iceUseIpv6: true,
  iceFilterStunResponse: undefined,
  iceFilterCandidatePair: undefined,
  icePasswordPrefix: undefined,
  iceUseLinkLocalAddress: undefined,
  dtls: {},
  bundlePolicy: "max-compat",
  debug: {},
  midSuffix: false,
  forceTurnTCP: false,
};
