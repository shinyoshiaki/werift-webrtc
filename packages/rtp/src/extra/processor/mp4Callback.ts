import { appendFile } from "fs/promises";

import { PromiseQueue } from "../..";
import { MP4Base, type Mp4Input, type Mp4Output, type Track } from "./mp4";
import type { WebmOption } from "./webm";

export class MP4Callback extends MP4Base {
  private cb?: (input: Mp4Output) => Promise<void>;
  private queue = new PromiseQueue();
  constructor(tracks: Track[], options: WebmOption = {}) {
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

  pipe = (cb: (input: Mp4Output) => Promise<void>) => {
    this.cb = cb;
    this.start();
  };

  inputAudio = (input: Mp4Input) => {
    this.processAudioInput(input);
  };
  inputVideo = (input: Mp4Input) => {
    this.processVideoInput(input);
  };

  destroy = () => {
    this.cb = undefined;
    this.queue.cancel();
  };

  static saveToFileSystem = (path: string) => {
    const queue = new PromiseQueue();
    return async (value: Mp4Output) => {
      await queue.push(async () => {
        if (value.data) {
          await appendFile(path, value.data);
        } else if (value.eol) {
        }
      });
    };
  };
}
