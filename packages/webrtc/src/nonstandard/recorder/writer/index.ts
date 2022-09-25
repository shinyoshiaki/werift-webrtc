import { MediaStreamTrack } from "../../..";
import { MediaRecorderOptions } from "..";

export abstract class MediaWriter {
  constructor(
    protected path: string,
    protected options: MediaRecorderOptions
  ) {}

  start(tracks: MediaStreamTrack[]) {}

  async stop() {}
}
