import { EventTarget } from "../../helper";
import { Event, debug } from "../../imports/common";
import type {
  IceGathererState,
  RTCIceConnectionState,
} from "../../transport/ice";
import type { Callback, CallbackWithValue } from "../../types/util";

const log = debug("werift:webrtc/stateManager");

export class StateManager extends EventTarget {
  connectionState: ConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: IceGathererState = "new";
  signalingState: RTCSignalingState = "stable";
  onsignalingstatechange?: CallbackWithValue<any>;
  onconnectionstatechange?: Callback;
  oniceconnectionstatechange?: Callback;
  readonly signalingStateChange = new Event<[RTCSignalingState]>();
  readonly connectionStateChange = new Event<[ConnectionState]>();
  readonly iceGatheringStateChange = new Event<[IceGathererState]>();
  readonly iceConnectionStateChange = new Event<[RTCIceConnectionState]>();

  updateIceGatheringState(newState: IceGathererState) {
    if (this.iceGatheringState === newState) {
      return;
    }

    log("iceGatheringStateChange", newState);
    this.iceGatheringState = newState;

    this.iceGatheringStateChange.execute(newState);
    this.emit("icegatheringstatechange", newState);
  }

  updateIceConnectionState(newState: RTCIceConnectionState) {
    if (this.iceConnectionState === newState) {
      return;
    }

    log("iceConnectionStateChange", newState);
    this.iceConnectionState = newState;

    this.iceConnectionStateChange.execute(newState);
    this.emit("iceconnectionstatechange", newState);
    this.oniceconnectionstatechange?.();
  }

  setSignalingState(state: RTCSignalingState) {
    log("signalingStateChange", state);
    this.signalingState = state;

    this.signalingStateChange.execute(state);
    this.onsignalingstatechange?.({});
  }

  setConnectionState(state: ConnectionState) {
    log("connectionStateChange", state);
    this.connectionState = state;

    this.connectionStateChange.execute(state);
    this.onconnectionstatechange?.();
    this.emit("connectionstatechange");
  }
}

export const SignalingStates = [
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
  "closed",
] as const;

export type RTCSignalingState = (typeof SignalingStates)[number];

export const ConnectionStates = [
  "closed",
  "failed",
  "disconnected",
  "new",
  "connecting",
  "connected",
] as const;

export type ConnectionState = (typeof ConnectionStates)[number];
