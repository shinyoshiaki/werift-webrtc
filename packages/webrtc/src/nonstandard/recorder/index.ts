import { Event } from "../../imports/common";
import type {
  JitterBufferOptions,
  LipSyncOptions,
} from "../../imports/rtpExtra";
import type { MediaStreamTrack } from "../../media/track";
import type { MediaWriter, StreamEvent } from "./writer";
import { WebmFactory } from "./writer/webm";

export type { StreamEvent };

export class MediaRecorder {
  writer: MediaWriter;
  ext?: string;
  tracks: MediaStreamTrack[] = [];
  started = false;
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
            stream?: StreamEvent;
          }
        | {
            path?: string;
            stream: StreamEvent;
          }
      ),
  ) {
    this.tracks = props.tracks ?? this.tracks;

    const { path, stream } = props;

    if (path) {
      this.ext = path.split(".").slice(-1)[0];
      this.writer = (() => {
        switch (this.ext) {
          case "webm":
            return new WebmFactory({
              ...props,
              path: path!,
              stream: stream!,
            });
          default:
            throw new Error();
        }
      })();
    } else {
      this.writer = new WebmFactory({
        ...props,
        path: path!,
        stream: stream!,
      });
    }

    if (this.tracks.length > 0) {
      this.props.numOfTracks = this.tracks.length;
      this.start().catch((error) => {
        this.onError.execute(error);
      });
    }
  }

  async addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
    await this.start();
  }

  private async start() {
    if (
      this.tracks.length === this.props.numOfTracks &&
      this.started === false
    ) {
      this.started = true;
      await this.writer.start(this.tracks);
    }
  }

  async stop() {
    await this.writer.stop();
  }
}

export interface MediaRecorderOptions {
  width: number;
  height: number;
  roll: number;
  disableLipSync: boolean;
  disableNtp: boolean;
  defaultDuration: number;
  tracks: MediaStreamTrack[];
  lipsync: Partial<LipSyncOptions>;
  jitterBuffer: Partial<JitterBufferOptions>;
}
