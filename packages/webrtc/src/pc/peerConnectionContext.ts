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
import {
  type ConnectionState,
  type RTCSignalingState,
  StateManager,
} from "./managers/stateManager";
import type { PeerConfig } from "./util";
import { updateIceConnectionState, updateIceGatheringState } from "./util";

const log = debug("werift:packages/webrtc/src/pc/peerConnectionContext.ts");

export class RTCPeerConnectionContext extends EventTarget {
  readonly cname = randomUUID();
  config: Required<PeerConfig> = cloneDeep<PeerConfig>(defaultPeerConfig);
  negotiationneeded = false;
  needRestart = false;
  sctpRemotePort?: number;
  sctpTransport?: RTCSctpTransport;
  protected readonly transceivers: RTCRtpTransceiver[] = [];
  protected readonly router = new RtpRouter();
  protected certificate?: RTCCertificate;
  protected seenMid = new Set<string>();
  protected currentLocalDescription?: SessionDescription;
  protected currentRemoteDescription?: SessionDescription;
  protected pendingLocalDescription?: SessionDescription;
  protected pendingRemoteDescription?: SessionDescription;
  protected isClosed = false;
  protected shouldNegotiationneeded = false;

  protected readonly stateManager = new StateManager();
  readonly iceGatheringStateChange = this.stateManager.iceGatheringStateChange;
  readonly iceConnectionStateChange =
    this.stateManager.iceConnectionStateChange;
  readonly signalingStateChange = this.stateManager.signalingStateChange;
  readonly connectionStateChange = this.stateManager.connectionStateChange;

  constructor() {
    super();
  }

  get dtlsTransports() {
    const transports = this.transceivers.map((t) => t.dtlsTransport);
    if (this.sctpTransport) {
      transports.push(this.sctpTransport.dtlsTransport);
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

  get connectionState() {
    return this.stateManager.connectionState;
  }

  get iceConnectionState() {
    return this.stateManager.iceConnectionState;
  }

  get iceGatheringState() {
    return this.stateManager.iceGatheringState;
  }

  get signalingState() {
    return this.stateManager.signalingState;
  }

  /**@private */
  get _localDescription() {
    return this.pendingLocalDescription || this.currentLocalDescription;
  }

  /**@private */
  get _remoteDescription() {
    return this.pendingRemoteDescription || this.currentRemoteDescription;
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

  get remoteIsBundled() {
    const remoteSdp = this._remoteDescription;
    if (!remoteSdp) {
      return undefined;
    }
    const bundle = remoteSdp.group.find(
      (g) => g.semantic === "BUNDLE" && this.config.bundlePolicy !== "disable",
    );
    return bundle;
  }

  protected pushTransceiver(t: RTCRtpTransceiver) {
    this.transceivers.push(t);
  }

  protected replaceTransceiver(t: RTCRtpTransceiver, index: number) {
    this.transceivers[index] = t;
  }

  protected getTransceiverByMid(mid: string) {
    return this.transceivers.find((transceiver) => transceiver.mid === mid);
  }

  protected getTransceiverByMLineIndex(index: number) {
    return this.transceivers.find(
      (transceiver) => transceiver.mLineIndex === index,
    );
  }

  protected getTransportByMid(mid: string) {
    let iceTransport: RTCIceTransport | undefined;

    const transceiver = this.transceivers.find((t) => t.mid === mid);
    if (transceiver) {
      iceTransport = transceiver.dtlsTransport.iceTransport;
    } else if (!iceTransport && this.sctpTransport?.mid === mid) {
      iceTransport = this.sctpTransport?.dtlsTransport.iceTransport;
    }

    return iceTransport;
  }

  protected getTransportByMLineIndex(sdp: SessionDescription, index: number) {
    const media = sdp.media[index];
    if (!media) {
      return;
    }
    const transport = this.getTransportByMid(media.rtp.muxId!);

    return transport;
  }

  protected setSignalingState(state: RTCSignalingState) {
    this.stateManager.setSignalingState(state);
  }

  protected setConnectionState(state: ConnectionState) {
    this.stateManager.setConnectionState(state);
  }

  protected updateIceGatheringState() {
    const all = this.iceTransports;
    const newState = updateIceGatheringState(all.map((t) => t.gatheringState));
    this.stateManager.updateIceGatheringState(newState);
  }

  protected updateIceConnectionState() {
    const newState =
      this.connectionState === "closed"
        ? "closed"
        : updateIceConnectionState({
            iceStates: this.iceTransports.map((t) => t.state),
          });

    this.stateManager.updateIceConnectionState(newState);
  }

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

  // This method will be implemented by child classes
  protected onNegotiationNeeded() {
    // To be overridden
  }

  protected assertNotClosed() {
    if (this.isClosed) {
      throw new Error("RTCPeerConnection is closed");
    }
  }

  toJSON() {
    return {
      cname: this.cname,
      config: this.config,
      negotiationneeded: this.negotiationneeded,
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
