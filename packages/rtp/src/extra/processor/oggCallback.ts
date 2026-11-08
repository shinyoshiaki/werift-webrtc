import { appendFile, writeFile } from "fs/promises";

import { PromiseQueue } from "../..";
import { Event } from "../../imports/common";
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
  /** a failed output callback (e.g. file write error) is reported here instead of an unhandled rejection */
  onError = new Event<[Error]>();
  constructor(track: OggTrack = {}, options: OggOption = {}) {
    super(
      track,
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
 * Append-only file writer for {@link OggCallback} output. The first write
 * replaces an existing file at `path`.
 * Unlike WebM, Ogg needs no header rewrite after the last page.
 *
 * @param path
 * @returns eol
 */
export const saveOggToFileSystem = (path: string) => {
  const queue = new PromiseQueue();
  let opened = false;
  return async (value: OggOutput): Promise<boolean> => {
    return await queue.push<boolean>(async () => {
      if (value.saveToFile) {
        if (opened) {
          await appendFile(path, value.saveToFile);
        } else {
          // the first write truncates, so an existing file is replaced even
          // where it cannot be deleted
          await writeFile(path, value.saveToFile);
          opened = true;
        }
      }
      return !!value.eol;
    });
  };
};
