import type { RTCDataChannel } from "./dataChannel";
import type {
  MediaStream,
  MediaStreamTrack,
  RTCRtpReceiver,
  RTCRtpTransceiver,
} from "./media";
import type { RTCIceCandidate } from "./transport/ice";
import type { Callback, CallbackWithValue } from "./types/util";

// Events RTCPeerConnection dispatches and the `on*` handler attributes.

export class RTCTrackEvent {
  readonly type = "track";
  readonly track: MediaStreamTrack;
  readonly streams: MediaStream[];
  readonly transceiver: RTCRtpTransceiver;
  readonly receiver: RTCRtpReceiver;

  constructor(init: {
    track: MediaStreamTrack;
    streams: MediaStream[];
    transceiver: RTCRtpTransceiver;
    receiver: RTCRtpReceiver;
  }) {
    this.track = init.track;
    this.streams = [...init.streams];
    this.transceiver = init.transceiver;
    this.receiver = init.receiver;
  }
}

export interface RTCDataChannelEvent {
  type?: "datachannel";
  channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEvent {
  type?: "icecandidate";
  candidate?: RTCIceCandidate;
}

export type PeerConnectionEventHandlers = {
  ondatachannel?: CallbackWithValue<RTCDataChannelEvent>;
  onicecandidate?: CallbackWithValue<RTCPeerConnectionIceEvent>;
  onicecandidateerror?: CallbackWithValue<any>;
  onicegatheringstatechange?: CallbackWithValue<any>;
  onnegotiationneeded?: CallbackWithValue<any>;
  onsignalingstatechange?: CallbackWithValue<any>;
  ontrack?: CallbackWithValue<RTCTrackEvent>;
  onconnectionstatechange?: Callback;
  oniceconnectionstatechange?: Callback;
};
