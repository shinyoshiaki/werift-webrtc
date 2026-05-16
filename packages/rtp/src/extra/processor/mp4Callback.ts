import { appendFile } from "fs/promises";

import { PromiseQueue } from "../..";
import {
  MP4Base,
  type MP4Option,
  type Mp4Input,
  type Mp4Output,
  type Track,
} from "./mp4";

export class MP4Callback extends MP4Base {
  private cb?: (input: Mp4Output) => Promise<void>;
  private queue = new PromiseQueue();
  constructor(tracks: Track[], options: MP4Option = {}) {
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
    void this.stop().finally(() => {
      this.cb = undefined;
      this.queue.cancel();
    });
  };

  static saveToFileSystem = (path: string) => {
    const queue = new PromiseQueue();
    return async (value: Mp4Output) => {
      await queue.push(async () => {
        if ("data" in value) {
          await appendFile(path, value.data);
        } else if (value.eol) {
        }
      });
    };
  };
}
