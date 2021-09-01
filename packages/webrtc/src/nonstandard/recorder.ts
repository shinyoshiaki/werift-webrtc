import { rename, unlink } from "fs/promises";

import { MediaStreamTrack } from "../media/track";
import { WebmLive, WebmSeekable } from "./webm";

export class MediaRecorder {
  live?: WebmLive;
  seekable?: WebmSeekable;

  constructor(
    public tracks: MediaStreamTrack[],
    public path: string,
    public options: Partial<{ width: number; height: number }> = {}
  ) {}

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }

  start() {
    this.live = new WebmLive(this.tracks, this.path, this.options);
    this.live.start();
    this.seekable = new WebmSeekable(
      this.tracks,
      this.path + ".static",
      this.options
    );
    this.seekable.start();
  }

  async stop() {
    if (!this.live || !this.seekable) throw new Error();
    await Promise.all([this.live.stop(), this.seekable.stop()]);
    await unlink(this.live.path);
    await rename(this.seekable.path, this.live.path);
  }
}
