import { MediaStreamTrack } from "../../media/track";
import { MediaWriter } from "./writer";
import { WebmFactory } from "./writer/webm";

export class MediaRecorder {
  writer: MediaWriter;
  ext: string;

  constructor(
    public tracks: MediaStreamTrack[],
    public path: string,
    public options: MediaRecorderOptions
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
  }

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }

  start() {
    this.writer.start(this.tracks);
  }

  async stop() {
    await this.writer.stop();
  }
}

export interface MediaRecorderOptions {
  width: number;
  height: number;
}
