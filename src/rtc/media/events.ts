import { RTCRtpReceiver } from "./rtpReceiver";
import { RTCRtpTransceiver } from "./rtpTransceiver";
import { MediaStreamTrack } from "./mediastream";

export class RTCTrackEvent {
  receiver: RTCRtpReceiver;
  transceiver: RTCRtpTransceiver;
  track: MediaStreamTrack;

  constructor(props: Partial<RTCTrackEvent> = {}) {
    Object.assign(this, props);
  }
}
