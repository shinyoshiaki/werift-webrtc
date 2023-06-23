import { appendFile, open, stat } from "fs/promises";

import { PromiseQueue, SupportedCodec } from "..";
import {
  DurationPosition,
  replaceSegmentSize,
  SegmentSizePosition,
  WebmBase,
  WebmInput,
  WebmOption,
  WebmOutput,
} from "./webm";

export class WebmCallback extends WebmBase {
  private cb?: (input: WebmOutput) => Promise<void>;
  private queue = new PromiseQueue();
  constructor(
    tracks: {
      width?: number;
      height?: number;
      kind: "audio" | "video";
      codec: SupportedCodec;
      clockRate: number;
      trackNumber: number;
    }[],
    options: WebmOption = {}
  ) {
    super(
      tracks,
      async (output) => {
        const cb = this.cb;
        if (cb) {
          await this.queue.push(() => cb(output));
        }
      },
      options
    );
  }

  pipe = (cb: (input: WebmOutput) => Promise<void>) => {
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

export const saveToFileSystem = (path: string) => async (value: WebmOutput) => {
  if (value.saveToFile) {
    await appendFile(path, value.saveToFile);
  } else if (value.eol) {
    const { durationElement } = value.eol;
    const handler = await open(path, "r+");

    // set duration
    await handler.write(
      durationElement,
      0,
      durationElement.length,
      DurationPosition
    );

    // set size
    const meta = await stat(path);
    const resize = replaceSegmentSize(meta.size);
    await handler.write(resize, 0, resize.length, SegmentSizePosition);

    await handler.close();
  }
};
