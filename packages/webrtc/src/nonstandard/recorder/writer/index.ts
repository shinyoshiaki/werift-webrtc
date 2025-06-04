import type { MediaRecorderOptions } from "../index.js";
import type { MediaStreamTrack } from "../../../index.js";
import type { Event } from "../../../imports/common.js";
import type { WebmOutput } from "../../../imports/rtpExtra.js";

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
