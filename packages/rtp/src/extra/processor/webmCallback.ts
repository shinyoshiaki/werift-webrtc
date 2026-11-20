import { PromiseQueue } from "../..";
import { Event } from "../../imports/common";
import {
  WebmBase,
  type WebmInput,
  type WebmOption,
  type WebmOutput,
  type WebmTrack,
} from "./webm";
import { createWebmFileWriter } from "./webmFileWriter";

export class WebmCallback extends WebmBase {
  private cb?: (input: WebmOutput) => Promise<void>;
  private queue = new PromiseQueue();
  /** a failed output callback (e.g. file write error) is reported here instead of an unhandled rejection */
  onError = new Event<[Error]>();
  constructor(tracks: WebmTrack[], options: WebmOption = {}) {
    super(
      tracks,
      async (output) => {
        const cb = this.cb;
        if (cb) {
          await this.queue
            .push(() => cb(output))
            .catch((error) => {
              this.onError.execute(error);
            });
        }
      },
      options,
    );
  }

  pipe = (cb: (input: WebmOutput) => Promise<any>) => {
    this.cb = cb;
    this.start();
  };

  inputAudio = (input: WebmInput) => {
    this.processAudioInput(input);
  };
  inputVideo = (input: WebmInput) => {
    this.processVideoInput(input);
  };

  destroy = () => {
    this.cb = undefined;
    this.queue.cancel();
  };
}

/**
 * File writer for {@link WebmCallback} output. Each chunk is written at its
 * `position` (positional write, so a retry never appends it twice) and the
 * first chunk replaces an existing file at `path`. On eol the Duration,
 * Cluster and Segment sizes are rewritten in place. A transient file access
 * error (`EBUSY`) is retried a bounded number of times with a short backoff;
 * any other error fails immediately. After a failure nothing more is written.
 *
 * Create one writer per recording.
 *
 * @param path
 * @returns eol
 */
export const saveToFileSystem = (path: string) => createWebmFileWriter(path);
