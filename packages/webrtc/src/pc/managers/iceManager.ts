import { EventTarget } from "../../helper";
import { Event, debug } from "../../imports/common";
import {
  IceCandidate,
  type RTCIceCandidate,
  RTCIceGatherer,
  RTCIceTransport,
} from "../../transport/ice";
import type { Callback } from "../../types/util";
import { parseIceServers } from "../../utils";
import type { PeerConfig } from "../util";
import { updateIceConnectionState, updateIceGatheringState } from "../util";
import type { ConnectionState, RTCSignalingState } from "./stateManager";

const log = debug("werift:webrtc/iceManager");

/**
 * ICE Manager
 * Handles ICE (Interactive Connectivity Establishment) related operations
 */
export class IceManager {
  private transports: RTCIceTransport[] = [];
  private needRestart = false;

  constructor() {}

  /**
   * Create a new ICE transport
   */
  createIceTransport(
    config: Required<PeerConfig>,
    bundlePolicy: string,
    existingTransport?: RTCIceTransport,
  ) {
    // If using max-bundle policy and there's an existing transport, reuse it
    if (bundlePolicy === "max-bundle" && existingTransport) {
      return existingTransport;
    }

    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(config.iceServers),
      forceTurn: config.iceTransportPolicy === "relay",
      portRange: config.icePortRange,
      interfaceAddresses: config.iceInterfaceAddresses,
      additionalHostAddresses: config.iceAdditionalHostAddresses,
      filterStunResponse: config.iceFilterStunResponse,
      filterCandidatePair: config.iceFilterCandidatePair,
      localPasswordPrefix: config.icePasswordPrefix,
      useIpv4: config.iceUseIpv4,
      useIpv6: config.iceUseIpv6,
      turnTransport: config.forceTurnTCP === true ? "tcp" : "udp",
      useLinkLocalAddress: config.iceUseLinkLocalAddress,
    });

    // If there's an existing transport, maintain the same credentials
    if (existingTransport) {
      iceGatherer.connection.localUsername =
        existingTransport.connection.localUsername;
      iceGatherer.connection.localPassword =
        existingTransport.connection.localPassword;
    }

    const iceTransport = new RTCIceTransport(iceGatherer);
    this.transports.push(iceTransport);

    return iceTransport;
  }

  /**
   * Mark ICE for restart
   */
  restartIce() {
    this.needRestart = true;
    return this.needRestart;
  }

  /**
   * Check if ICE restart is needed
   */
  isRestartRequired() {
    return this.needRestart;
  }

  /**
   * Clear the restart flag
   */
  clearRestartFlag() {
    this.needRestart = false;
  }

  /**
   * Add a remote ICE candidate
   */
  async addRemoteCandidate(
    transport: RTCIceTransport,
    candidate?: RTCIceCandidate,
  ) {
    if (!transport) {
      log("transport not found");
      return;
    }

    const iceCandidate = candidate
      ? IceCandidate.fromJSON(candidate)
      : undefined;
    await transport.addRemoteCandidate(iceCandidate);
  }

  /**
   * Gather ICE candidates
   */
  async gatherCandidates(remoteIsBundled: boolean | undefined = false) {
    // If using a bundled connection and already have a connected transport, skip gathering
    const connectedTransport = this.transports.find(
      (transport) => transport.state === "connected",
    );

    if (remoteIsBundled && connectedTransport) {
      // No need to gather candidates on an existing bundled connection
      log("skip gathering on existing bundled connection");
      return;
    }

    // Gather candidates for all transports
    await Promise.allSettled(
      this.transports.map((transport) => transport.gather()),
    );
  }

  /**
   * Start the ICE connection process
   */
  async startIceTransport(transport: RTCIceTransport) {
    if (transport.state === "connected") {
      log("ICE transport already connected");
      return;
    }

    await transport.start();
  }

  /**
   * Start all ICE transports
   */
  async startAllIceTransports() {
    return Promise.allSettled(
      this.transports.map((transport) => this.startIceTransport(transport)),
    );
  }

  /**
   * Update the ICE gathering state
   */
  getIceGatheringState() {
    if (this.transports.length === 0) {
      return "new";
    }
    return updateIceGatheringState(
      this.transports.map((t) => t.gatheringState),
    );
  }

  /**
   * Update the ICE connection state
   */
  getIceConnectionState(connectionState: ConnectionState) {
    if (connectionState === "closed" || this.transports.length === 0) {
      return "closed";
    }
    return updateIceConnectionState({
      iceStates: this.transports.map((t) => t.state),
    });
  }

  /**
   * Get all ICE transports
   */
  getAllIceTransports() {
    return this.transports;
  }

  /**
   * Stop all ICE transports
   */
  async stopAllTransports() {
    await Promise.all(this.transports.map((transport) => transport.stop()));
    this.transports = [];
  }

  /**
   * Set ICE role (controlling/controlled) based on description type
   */
  setIceRole(
    isOffer: boolean,
    transport: RTCIceTransport,
    remoteIsLite: boolean = false,
  ) {
    // Set ICE role
    if (isOffer) {
      transport.connection.iceControlling = true;
    } else {
      transport.connection.iceControlling = false;
    }

    // One agent full, one lite: The full agent MUST take the controlling role,
    // and the lite agent MUST take the controlled role - RFC 8445 S6.1.1
    if (remoteIsLite) {
      transport.connection.iceControlling = true;
    }
  }

  /**
   * Set ICE parameters from remote description
   */
  setRemoteIceParams(
    transport: RTCIceTransport,
    iceParams: any,
    renomination: boolean = false,
  ) {
    if (!iceParams) return;

    transport.setRemoteParams(iceParams, renomination);

    // Set controlling role if remote is lite
    if (iceParams.iceLite) {
      transport.connection.iceControlling = true;
    }
  }

  /**
   * Find transport by ID
   */
  findTransportById(id: string) {
    return this.transports.find((t) => t.id === id);
  }

  /**
   * Remove a transport from the manager
   */
  removeTransport(id: string) {
    const index = this.transports.findIndex((t) => t.id === id);
    if (index >= 0) {
      this.transports.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Serialize to JSON for live migration
   */
  toJSON() {
    return {
      needRestart: this.needRestart,
      // Note: Transport objects themselves would need to be serialized separately
      // as they contain complex state that would require special handling
      transportIds: this.transports.map((t) => t.id),
    };
  }

  /**
   * Restore from JSON for live migration
   */
  fromJSON(json: any, transportMap: Map<string, RTCIceTransport>) {
    if (json.needRestart !== undefined) {
      this.needRestart = json.needRestart;
    }

    // Restore transport references using the provided map
    if (json.transportIds && Array.isArray(json.transportIds)) {
      this.transports = json.transportIds
        .map((id) => transportMap.get(id))
        .filter((t) => t !== undefined) as RTCIceTransport[];
    }
  }
}
