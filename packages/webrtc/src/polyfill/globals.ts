import type { RTCDataChannel as WeriftRTCDataChannel } from "../dataChannel";
import type { OverconstrainedError as WeriftOverconstrainedError } from "../errors";
import type {
  MediaStream as WeriftMediaStream,
  MediaStreamTrack as WeriftMediaStreamTrack,
  RTCRtpReceiver as WeriftRTCRtpReceiver,
  RTCRtpSender as WeriftRTCRtpSender,
  RTCRtpTransceiver as WeriftRTCRtpTransceiver,
} from "../media";
import type {
  RTCPeerConnection as WeriftRTCPeerConnection,
  RTCPeerConnectionIceErrorEvent as WeriftRTCPeerConnectionIceErrorEvent,
  RTCTrackEvent as WeriftRTCTrackEvent,
} from "../peerConnection";
import type { RTCSessionDescription as WeriftRTCSessionDescription } from "../sdp";
import type { RTCDtlsTransport as WeriftRTCDtlsTransport } from "../transport/dtls";
import type {
  RTCIceCandidate as WeriftRTCIceCandidate,
  RTCIceTransport as WeriftRTCIceTransport,
} from "../transport/ice";
import type { MediaDevices } from "./mediaDevices";

declare global {
  var RTCPeerConnection: typeof WeriftRTCPeerConnection;
  var RTCSessionDescription: typeof WeriftRTCSessionDescription;
  var RTCIceCandidate: typeof WeriftRTCIceCandidate;
  var RTCDataChannel: typeof WeriftRTCDataChannel;
  var MediaStream: typeof WeriftMediaStream;
  var MediaStreamTrack: typeof WeriftMediaStreamTrack;
  var RTCRtpSender: typeof WeriftRTCRtpSender;
  var RTCRtpReceiver: typeof WeriftRTCRtpReceiver;
  var RTCRtpTransceiver: typeof WeriftRTCRtpTransceiver;
  var RTCIceTransport: typeof WeriftRTCIceTransport;
  var RTCDtlsTransport: typeof WeriftRTCDtlsTransport;
  var RTCTrackEvent: typeof WeriftRTCTrackEvent;
  var RTCPeerConnectionIceErrorEvent: typeof WeriftRTCPeerConnectionIceErrorEvent;
  var OverconstrainedError: typeof WeriftOverconstrainedError;

  interface Navigator {
    mediaDevices: MediaDevices;
    userAgent: string;
  }

  var navigator: Navigator;
}
