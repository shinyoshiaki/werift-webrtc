import { appendFile, open, stat } from "fs/promises";

import { PromiseQueue } from "../..";
import {
  DurationPosition,
  SegmentSizePosition,
  WebmBase,
  type WebmInput,
  type WebmOption,
  type WebmOutput,
  type WebmTrack,
  replaceSegmentSize,
} from "./webm";

export class WebmCallback extends WebmBase {
  private cb?: (input: WebmOutput) => Promise<void>;
  private queue = new PromiseQueue();
  constructor(tracks: WebmTrack[], options: WebmOption = {}) {
    super(
      tracks,
      async (output) => {
        const cb = this.cb;
        if (cb) {
          await this.queue.push(() => cb(output));
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
 *
 * @param path
 * @returns eol
 */
export const saveToFileSystem = (path: string) => {
  const queue = new PromiseQueue();
  return async (value: WebmOutput): Promise<boolean> => {
    return await queue.push<boolean>(async () => {
      if (value.saveToFile) {
        await appendFile(path, value.saveToFile);

        return false;
      } else if (value.eol) {
        const { durationElement } = value.eol;
        const handler = await open(path, "r+");

        // set duration
        await handler.write(
          durationElement,
          0,
          durationElement.length,
          DurationPosition,
        );

        // set size
        const meta = await stat(path);
        const resize = replaceSegmentSize(meta.size);
        await handler.write(resize, 0, resize.length, SegmentSizePosition);

        await handler.close();

        return true;
      }

      return false;
    });
  };
};
