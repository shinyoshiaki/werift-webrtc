import { createSocket } from "dgram";
import { RTCRtpCodecParameters } from "..";
import { MediaStream, MediaStreamTrack } from "../media/track";
import {
  type DummyAudioOptions,
  type DummyVideoOptions,
  createDummyAudioTrack,
  createDummyVideoTrack,
} from "./dummyMedia";

export class Navigator {
  mediaDevices: MediaDevices;

  constructor(props: ConstructorParameters<typeof MediaDevices>[0] = {}) {
    this.mediaDevices = new MediaDevices(props);
  }
}

export class MediaDevices extends EventTarget {
  video?: MediaStreamTrack;
  audio?: MediaStreamTrack;
  private readonly activeSourceStops = new Map<MediaStreamTrack, () => void>();

  constructor(readonly props: MediaDeviceProps = {}) {
    super();
    this.video = props.video;
    this.audio = props.audio;
  }

  readonly getUserMedia = async (
    constraints: MediaStreamConstraints,
  ): Promise<MediaStream> => {
    const tracks = [
      ...(constraints.audio
        ? [this.createTrack("audio", constraints.audio)]
        : []),
      ...(constraints.video
        ? [this.createTrack("video", constraints.video)]
        : []),
    ];

    if (tracks.length === 0) {
      throw new Error("At least one audio or video track is required");
    }

    return new MediaStream(tracks);
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

  cleanup() {
    for (const stop of this.activeSourceStops.values()) {
      stop();
    }
    this.activeSourceStops.clear();
  }

  private createTrack(
    kind: "audio" | "video",
    constraints: boolean | MediaTrackConstraints,
  ) {
    const existingTrack = kind === "audio" ? this.audio : this.video;
    if (existingTrack) {
      return this.createClonedTrack(kind, existingTrack);
    }
    if (this.props.dummyMedia?.enabled) {
      return this.createDummyTrack(kind, constraints);
    }
    throw new Error(`No ${kind} source configured for getUserMedia`);
  }

  private createClonedTrack(
    kind: "audio" | "video",
    sourceTrack: MediaStreamTrack,
  ) {
    const track = new MediaStreamTrack({ kind });
    const { unSubscribe } = sourceTrack.onReceiveRtp.subscribe((rtp) => {
      track.onReceiveRtp.execute(rtp.clone());
    });
    this.attachTrackStop(track, () => {
      unSubscribe();
    });
    return track;
  }

  private createDummyTrack(
    kind: "audio" | "video",
    constraints: boolean | MediaTrackConstraints,
  ) {
    const dummy =
      kind === "audio"
        ? createDummyAudioTrack(this.props.dummyMedia?.audio)
        : createDummyVideoTrack({
            ...this.props.dummyMedia?.video,
            ...resolveVideoOptions(constraints),
          });

    this.attachTrackStop(dummy.track, () => {
      dummy.source.stop();
    });

    return dummy.track;
  }

  private attachTrackStop(track: MediaStreamTrack, stop: () => void) {
    let disposed = false;
    const originalStop = track.stop;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      stop();
      this.activeSourceStops.delete(track);
    };

    track.stop = () => {
      dispose();
      originalStop();
    };

    this.activeSourceStops.set(track, dispose);
  }
}

interface MediaDeviceProps {
  video?: MediaStreamTrack;
  audio?: MediaStreamTrack;
  dummyMedia?: {
    enabled: boolean;
    audio?: Partial<DummyAudioOptions>;
    video?: Partial<DummyVideoOptions>;
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

function resolveVideoOptions(
  constraints: boolean | MediaTrackConstraints,
): Partial<DummyVideoOptions> {
  if (typeof constraints === "boolean") {
    return {};
  }

  const fps = resolveConstrainNumber(constraints.frameRate);
  if (!fps) {
    return {};
  }

  return {
    fps,
    keyframeIntervalFrames: Math.max(1, Math.round(fps)),
  };
}

function resolveConstrainNumber(
  value?: ConstrainDouble | ConstrainULong,
): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  return value.exact ?? value.ideal ?? value.max ?? value.min;
}
