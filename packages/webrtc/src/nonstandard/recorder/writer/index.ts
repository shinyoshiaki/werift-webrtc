import type { MediaStreamTrack } from "../../..";
import type { Event } from "../../../imports/common";
import type { WebmOutput } from "../../../imports/rtpExtra";
import type { MediaRecorderOptions } from "..";

export abstract class MediaWriter {
  constructor(
    protected props: Partial<MediaRecorderOptions> & {
      path: string;
      stream?: StreamEvent;
    } & { path?: string; stream: StreamEvent },
  ) {}

  async start(tracks: MediaStreamTrack[]) {}

  async stop() {}
}

export type StreamEvent = Event<[WebmOutput]>;
