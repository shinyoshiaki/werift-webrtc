import { appendFile } from "fs/promises";

import { PromiseQueue } from "../..";
import {
  OggBase,
  type OggInput,
  type OggOption,
  type OggOutput,
  type OggTrack,
} from "./ogg";

export class OggCallback extends OggBase {
  private cb?: (input: OggOutput) => Promise<void>;
  private queue = new PromiseQueue();
  constructor(track: OggTrack = {}, options: OggOption = {}) {
    super(
      track,
      async (output) => {
        const cb = this.cb;
        if (cb) {
          await this.queue.push(() => cb(output));
        }
      },
      options,
    );
  }

  pipe = (cb: (input: OggOutput) => Promise<any>) => {
    this.cb = cb;
    this.start();
  };

  inputAudio = (input: OggInput) => {
    this.processAudioInput(input);
  };

  destroy = () => {
    this.cb = undefined;
    this.queue.cancel();
  };
}

/**
 * Append-only file writer for {@link OggCallback} output.
 * Unlike WebM, Ogg needs no header rewrite after the last page.
 *
 * @param path
 * @returns eol
 */
export const saveOggToFileSystem = (path: string) => {
  const queue = new PromiseQueue();
  return async (value: OggOutput): Promise<boolean> => {
    return await queue.push<boolean>(async () => {
      if (value.saveToFile) {
        await appendFile(path, value.saveToFile);
      }
      return !!value.eol;
    });
  };
};
