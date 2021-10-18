import { MediaStreamTrack } from "../../..";

export abstract class MediaWriter {
  constructor(protected path: string) {}

  start(tracks: MediaStreamTrack[]) {}

  async stop() {}
}
