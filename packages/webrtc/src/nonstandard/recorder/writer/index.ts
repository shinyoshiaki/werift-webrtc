import type { MediaStreamTrack } from "../../..";
import type { Event } from "../../../imports/common";
import type { OggOutput, WebmOutput } from "../../../imports/rtpExtra";
import type { MediaRecorderOptions } from "..";

export abstract class MediaWriter<O extends RecorderOutput = WebmOutput> {
  constructor(
    protected props: Partial<MediaRecorderOptions> & {
      path: string;
      stream?: StreamEvent<O>;
    } & { path?: string; stream: StreamEvent<O> },
  ) {}

  async start(tracks: MediaStreamTrack[]) {}

  async stop() {}
}

export type RecorderOutput = WebmOutput | OggOutput;

/** `StreamEvent` (WebM) by default, `StreamEvent<OggOutput>` for `format: "ogg"` */
export type StreamEvent<O extends RecorderOutput = WebmOutput> = Event<[O]>;
