import Event from "rx.mini";

import { MediaStreamTrack } from "../../media/track";
import { MediaWriter } from "./writer";
import { WebmFactory } from "./writer/webm";

export class MediaRecorder {
  writer: MediaWriter;
  ext: string;
  tracks: MediaStreamTrack[] = [];
  started = false;
  onError = new Event<[Error]>();

  constructor(
    public path: string,
    public numOfTracks = 1,
    public options: Partial<MediaRecorderOptions> = {}
  ) {
    this.ext = path.split(".").slice(-1)[0];
    this.writer = (() => {
      switch (this.ext) {
        case "webm":
          return new WebmFactory(path, options);
        default:
          throw new Error();
      }
    })();

    this.tracks = options.tracks ?? this.tracks;
    if (this.tracks.length === numOfTracks) {
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
    if (this.tracks.length === this.numOfTracks && this.started === false) {
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
  jitterBufferLatency: number;
  jitterBufferSize: number;
  waitForKeyframe: boolean;
  defaultDuration: number;
  tracks: MediaStreamTrack[];
}
