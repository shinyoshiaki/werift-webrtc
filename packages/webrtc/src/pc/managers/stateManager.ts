import { debug } from "../../imports/common";
import type { ConnectionState, RTCSignalingState } from "../../types/domain";
import type { BaseManager } from "../types/manager";
import { ManagerError } from "../types/manager";
import type { PeerConnectionContext } from "../types/peerConnectionContext";

const log = debug("werift:webrtc/stateManager");

export class StateManager implements BaseManager {
  constructor(public readonly context: PeerConnectionContext) {}

  updateSignalingState(state: RTCSignalingState) {
    if (this.context.connection.signalingState === state) return;

    log("signalingStateChange", state);
    this.context.connection.signalingState = state;

    this.context.connection.signalingStateChange.execute(state);
    this.context.connection.onsignalingstatechange?.({});
  }

  updateConnectionState(state: ConnectionState) {
    if (this.context.connection.connectionState === state) return;

    log("connectionStateChange", state);
    this.context.connection.connectionState = state;

    this.context.connection.connectionStateChange.execute(state);
    this.context.connection.onconnectionstatechange?.();
    this.context.connection.emit("connectionstatechange");
  }

  validateState(action: string) {
    if (this.context.connection.isClosed) {
      throw new ManagerError(
        "StateManager",
        `Cannot ${action}: RTCPeerConnection is closed`,
      );
    }
  }

  dispose() {
    // Cleanup any state-specific resources if needed
  }
}
