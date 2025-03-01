import type { MediaStreamTrack } from "../../media";
import type { RTCDataChannel } from "../dataChannel/rtcDataChannel";
import type { RTCIceCandidate } from "../../transport/ice";
import type {
  RTCRtpReceiver,
  RTCRtpTransceiver,
  MediaStream,
} from "../../media";

export interface RTCTrackEvent {
  track: MediaStreamTrack;
  streams: MediaStream[];
  transceiver: RTCRtpTransceiver;
  receiver: RTCRtpReceiver;
}

export interface RTCDataChannelEvent {
  channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEvent {
  candidate?: RTCIceCandidate;
}
