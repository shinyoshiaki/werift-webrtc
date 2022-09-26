import { MediaStreamTrack } from "../../..";
import { MediaRecorderOptions } from "..";

export abstract class MediaWriter {
  constructor(
    protected path: string,
    protected options: Partial<MediaRecorderOptions>
  ) {}

  async start(tracks: MediaStreamTrack[]) {}

  async stop() {}
}
