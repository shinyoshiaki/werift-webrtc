import { randomUUID } from "node:crypto";
import cloneDeep from "lodash/cloneDeep.js";
import { EventTarget } from "../helper";
import {
  type RTCRtpTransceiver,
  RtpRouter,
  useOPUS,
  usePCMU,
  useVP8,
} from "../media";
import type { SessionDescription } from "../sdp";
import type { RTCCertificate } from "../transport/dtls";
import type { RTCIceTransport } from "../transport/ice";
import type { RTCSctpTransport } from "../transport/sctp";
import {
  type ConnectionState,
  type RTCSignalingState,
  StateManager,
} from "./managers/stateManager";
import type { PeerConfig } from "./util";

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
