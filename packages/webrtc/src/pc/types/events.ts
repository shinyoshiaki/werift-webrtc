import type { MediaStreamTrack } from "../../media";
import type {
  MediaStream,
  RTCRtpReceiver,
  RTCRtpTransceiver,
} from "../../media";
import type { RTCIceCandidate } from "../../transport/ice";
import type { RTCDataChannel } from "../dataChannel/rtcDataChannel";

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
