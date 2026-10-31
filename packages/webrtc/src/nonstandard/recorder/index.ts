import { Event, WeriftError } from "../../imports/common";
import type {
  JitterBufferOptions,
  LipSyncOptions,
  OggOutput,
} from "../../imports/rtpExtra";
import type { MediaStreamTrack } from "../../media/track";
import type { MediaWriter, RecorderOutput, StreamEvent } from "./writer";
import { OggFactory } from "./writer/ogg";
import { WebmFactory } from "./writer/webm";

export type { RecorderOutput, StreamEvent };

/** container written by MediaRecorder */
export type MediaRecorderFormat = "webm" | "ogg";

const formatByExtension: Record<string, MediaRecorderFormat> = {
  webm: "webm",
  ogg: "ogg",
  opus: "ogg",
};

const sourcePath = "packages/webrtc/src/nonstandard/recorder/index.ts";

export class MediaRecorder {
  writer: MediaWriter<any>;
  ext?: string;
  format: MediaRecorderFormat;
  tracks: MediaStreamTrack[] = [];
  started = false;
  private starting?: Promise<void>;
  onError = new Event<[Error]>();

  constructor(
    public props: Partial<MediaRecorderOptions> &
      (
        | {
            numOfTracks: number;
            tracks?: MediaStreamTrack[];
          }
        | {
            numOfTracks?: number;
            tracks: MediaStreamTrack[];
          }
      ) &
      (
        | {
            path: string;
            stream?: StreamEvent | StreamEvent<OggOutput>;
          }
        | {
            path?: string;
            stream: StreamEvent | StreamEvent<OggOutput>;
          }
      ),
  ) {
    this.tracks = props.tracks ?? this.tracks;

    const { path, stream } = props;

    if (path) {
      this.ext = path.split(".").slice(-1)[0];
    }
    this.format = resolveFormat(this.ext, props.format);

    const writerProps = { ...props, path: path!, stream: stream as any };
    switch (this.format) {
      case "webm":
        this.writer = new WebmFactory(writerProps);
        break;
      case "ogg":
        if (props.numOfTracks !== undefined) {
          OggFactory.validateNumOfTracks(props.numOfTracks);
        }
        if (props.tracks) {
          OggFactory.validateTracks(props.tracks);
        }
        this.writer = new OggFactory(writerProps);
        break;
    }

    if (this.tracks.length > 0) {
      this.props.numOfTracks = this.tracks.length;
      this.start().catch((error) => {
        this.onError.execute(error);
      });
    }
  }

  async addTrack(track: MediaStreamTrack) {
    if (this.format === "ogg") {
      OggFactory.validateTrack(track);
    }
    this.tracks.push(track);
    await this.start();
  }

  private async start() {
    if (
      this.tracks.length === this.props.numOfTracks &&
      this.started === false
    ) {
      this.started = true;
      this.starting = this.writer.start(this.tracks);
      await this.starting;
    }
  }

  async stop() {
    // stop() right after construction must not race the asynchronous start
    await this.starting?.catch(() => undefined);
    await this.writer.stop();
  }
}

function resolveFormat(
  ext: string | undefined,
  format: MediaRecorderFormat | undefined,
): MediaRecorderFormat {
  const fromExt = ext !== undefined ? formatByExtension[ext] : undefined;
  if (format) {
    if (fromExt && fromExt !== format) {
      throw new WeriftError({
        message: `path extension .${ext} does not match format ${format}`,
        payload: { ext, format },
        path: sourcePath,
      });
    }
    if (!formatByExtension[format]) {
      throw new WeriftError({
        message: `unsupported format: ${format}`,
        payload: { format },
        path: sourcePath,
      });
    }
    return format;
  }
  if (ext === undefined) {
    // stream only: WebM for backward compatibility
    return "webm";
  }
  if (!fromExt) {
    throw new WeriftError({
      message: `unsupported file extension: .${ext} (supported: ${Object.keys(formatByExtension).join(", ")})`,
      payload: { ext },
      path: sourcePath,
    });
  }
  return fromExt;
}

export interface MediaRecorderOptions {
  /**
   * container format. Inferred from the `path` extension
   * (`.webm` -> webm, `.ogg` / `.opus` -> ogg); WebM when only `stream` is given.
   * Ogg records exactly one Opus audio track; pass a
   * `StreamEvent<OggOutput>` as `stream` with it.
   */
  format: MediaRecorderFormat;
  /** WebM only */
  width: number;
  /** WebM only */
  height: number;
  /** WebM only */
  roll: number;
  /** WebM only. Ogg has a single audio track and never lip-syncs */
  disableLipSync: boolean;
  disableNtp: boolean;
  /** WebM only */
  defaultDuration: number;
  tracks: MediaStreamTrack[];
  /** WebM only */
  lipsync: Partial<LipSyncOptions>;
  /** applied to video tracks only (WebM) */
  jitterBuffer: Partial<JitterBufferOptions>;
}
