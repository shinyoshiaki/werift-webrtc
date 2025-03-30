import { debug } from "../../imports/common";
import type {
  IceGathererState,
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceConnectionState,
} from "../../transport/ice";
import { IceCandidate } from "../../transport/ice";
import type { BaseManager } from "../types/manager";
import { ManagerError } from "../types/manager";
import type { PeerConnectionContext } from "../types/peerConnectionContext";
import { updateIceConnectionState, updateIceGatheringState } from "../util";

const log = debug("werift:webrtc/iceManager");

export class IceManager implements BaseManager {
  constructor(public readonly context: PeerConnectionContext) {}

  async addIceCandidate(
    candidateMessage: RTCIceCandidate | RTCIceCandidateInit,
  ) {
    const candidate = IceCandidate.fromJSON(candidateMessage);
    if (!candidate) return;

    let iceTransport = await this.findIceTransport(candidate);
    if (!iceTransport) {
      iceTransport = this.context.connection.iceTransports[0];
    }

    if (iceTransport) {
      await iceTransport.addRemoteCandidate(candidate);
    } else {
      log("iceTransport not found", candidate);
    }
  }

  private async findIceTransport(candidate: IceCandidate) {
    if (typeof candidate.sdpMid === "number") {
      return this.getTransportByMid(candidate.sdpMid);
    }

    if (typeof candidate.sdpMLineIndex === "number") {
      return this.getTransportByMLineIndex(candidate.sdpMLineIndex);
    }

    return undefined;
  }

  private getTransportByMid(mid: string) {
    const transceiver = this.context.connection.transceivers.find(
      (t) => t.mid === mid,
    );
    if (transceiver) {
      return transceiver.dtlsTransport.iceTransport;
    }

    if (this.context.connection.sctpTransport?.mid === mid) {
      return this.context.connection.sctpTransport.dtlsTransport.iceTransport;
    }

    return undefined;
  }

  private getTransportByMLineIndex(index: number) {
    const sdp = this.context.connection.buildOfferSdp();
    const media = sdp.media[index];
    if (!media) return;

    return this.getTransportByMid(media.rtp.muxId!);
  }

  async gatherCandidates() {
    const connected = this.context.connection.iceTransports.find(
      (transport) => transport.state === "connected",
    );

    if (this.context.connection.remoteIsBundled && connected) {
      // no need to gather ice candidates on an existing bundled connection
      return;
    }

    await Promise.allSettled(
      this.context.connection.iceTransports.map((iceTransport) =>
        iceTransport.gather(),
      ),
    );
  }

  updateIceGatheringState() {
    const all = this.context.connection.iceTransports;
    const newState = updateIceGatheringState(all.map((t) => t.gatheringState));

    if (this.context.connection.iceGatheringState === newState) return;

    log("iceGatheringStateChange", newState);
    this.context.connection.iceGatheringState = newState;

    this.context.connection.iceGatheringStateChange.execute(newState);
    this.context.connection.emit("icegatheringstatechange", newState);
  }

  updateIceConnectionState() {
    const newState =
      this.context.connection.connectionState === "closed"
        ? "closed"
        : updateIceConnectionState({
            iceStates: this.context.connection.iceTransports.map(
              (t) => t.state,
            ),
          });

    if (this.context.connection.iceConnectionState === newState) return;

    log("iceConnectionStateChange", newState);
    this.context.connection.iceConnectionState = newState;

    this.context.connection.iceConnectionStateChange.execute(newState);
    this.context.connection.emit("iceconnectionstatechange", newState);
    this.context.connection.oniceconnectionstatechange?.();
  }

  restartIce() {
    this.context.connection.needRestart = true;
    this.context.needNegotiation();
  }

  dispose() {
    // Cleanup any ICE-specific resources if needed
  }
}
