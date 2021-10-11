import { MediaStreamTrack } from "../media/track";
import { WebmFactoryAV1 } from "./av1";
import { WebmFactory } from "./webm";

export class MediaRecorder {
  webm?: WebmFactoryAV1;

  constructor(
    public tracks: MediaStreamTrack[],
    public path: string,
    public options: Partial<{ width: number; height: number }> = {}
  ) {}

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }

  async start() {
    this.webm = new WebmFactoryAV1(this.tracks, this.path, this.options);
    await this.webm.start();
  }

  async stop() {
    if (!this.webm) throw new Error();
    await this.webm.stop();
  }
}
