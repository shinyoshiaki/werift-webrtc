import { randomBytes } from "crypto";
import { createSocket } from "dgram";
import { jspack } from "@shinyoshiaki/jspack";
import { RTCRtpCodecParameters } from "..";
import { MediaStream, MediaStreamTrack } from "../media/track";

export class Navigator {
  mediaDevices: MediaDevices;

  constructor(props: ConstructorParameters<typeof MediaDevices>[0] = {}) {
    this.mediaDevices = new MediaDevices(props);
  }
}

export class MediaDevices extends EventTarget {
  video?: MediaStreamTrack;
  audio?: MediaStreamTrack;

  constructor(
    readonly props: { video?: MediaStreamTrack; audio?: MediaStreamTrack },
  ) {
    super();
    this.video = props.video;
    this.audio = props.audio;
  }

  readonly getUserMedia = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    const video = constraints.video
      ? new MediaStreamTrack({ kind: "video" })
      : undefined;
    if (video) {
      this.video?.onReceiveRtp.subscribe((rtp) => {
        const cloned = rtp.clone();
        cloned.header.ssrc = jspack.Unpack("!L", randomBytes(4))[0];
        video.onReceiveRtp.execute(cloned);
      });
    }
    const audio = constraints.audio
      ? new MediaStreamTrack({ kind: "audio" })
      : undefined;
    if (audio) {
      this.audio?.onReceiveRtp.subscribe((rtp) => {
        const cloned = rtp.clone();
        cloned.header.ssrc = jspack.Unpack("!L", randomBytes(4))[0];
        audio.onReceiveRtp.execute(cloned);
      });
    }

    if (constraints.video && constraints.audio) {
      return new MediaStream([video!, audio!]);
    } else if (constraints.audio) {
      return new MediaStream([audio!]);
    } else if (constraints.video) {
      return new MediaStream([video!]);
    }

    throw new Error("Not implemented");
  };

  readonly getDisplayMedia = this.getUserMedia;

  readonly getUdpMedia = ({
    port,
    codec,
  }: {
    port: number;
    codec: ConstructorParameters<typeof RTCRtpCodecParameters>[0];
  }) => {
    const kind = codec.mimeType.toLowerCase().includes("video")
      ? "video"
      : "audio";
    const track = new MediaStreamTrack({
      kind,
      codec: new RTCRtpCodecParameters(codec),
    });

    const udp = createSocket("udp4");
    udp.bind(port);
    udp.on("message", (data) => {
      track.writeRtp(data);
    });

    const disposer = () => {
      udp.close();
    };

    return { track, disposer };
  };
}

interface MediaStreamConstraints {
  audio?: boolean | MediaTrackConstraints;
  peerIdentity?: string;
  preferCurrentTab?: boolean;
  video?: boolean | MediaTrackConstraints;
}

interface MediaTrackConstraints extends MediaTrackConstraintSet {
  advanced?: MediaTrackConstraintSet[];
}

interface MediaTrackConstraintSet {
  aspectRatio?: ConstrainDouble;
  autoGainControl?: ConstrainBoolean;
  channelCount?: ConstrainULong;
  deviceId?: ConstrainDOMString;
  displaySurface?: ConstrainDOMString;
  echoCancellation?: ConstrainBoolean;
  facingMode?: ConstrainDOMString;
  frameRate?: ConstrainDouble;
  groupId?: ConstrainDOMString;
  height?: ConstrainULong;
  noiseSuppression?: ConstrainBoolean;
  sampleRate?: ConstrainULong;
  sampleSize?: ConstrainULong;
  width?: ConstrainULong;
}

type ConstrainDOMString = string | string[] | ConstrainDOMStringParameters;
interface ConstrainDOMStringParameters {
  exact?: string | string[];
  ideal?: string | string[];
}
type ConstrainBoolean = boolean | ConstrainBooleanParameters;
interface ConstrainBooleanParameters {
  exact?: boolean;
  ideal?: boolean;
}
type ConstrainULong = number | ConstrainULongRange;
interface ConstrainULongRange extends ULongRange {
  exact?: number;
  ideal?: number;
}
interface ULongRange {
  max?: number;
  min?: number;
}
type ConstrainDouble = number | ConstrainDoubleRange;
interface ConstrainDoubleRange extends DoubleRange {
  exact?: number;
  ideal?: number;
}
interface DoubleRange {
  max?: number;
  min?: number;
}

export const navigator = new Navigator();
