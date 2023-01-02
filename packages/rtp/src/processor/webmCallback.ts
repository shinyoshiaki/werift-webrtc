import { appendFile, open, stat } from "fs/promises";

import { PromiseQueue } from "../../../common/src";
import { SupportedCodec } from "../container/webm";
import {
  DurationPosition,
  replaceSegmentSize,
  SegmentSizePosition,
  WebmBase,
  WebmOption,
  WebmOutput,
} from "./webm";

export class WebmCallback extends WebmBase {
  private cb!: (input: WebmOutput) => Promise<void>;
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
      (output) => {
        if (this.cb) {
          this.queue.push(() => this.cb(output));
        }
      },
      options
    );
  }

  pipe = (cb: (input: WebmOutput) => Promise<void>) => {
    this.cb = cb;
    this.start();
  };

  inputAudio = this.processAudioInput;
  inputVideo = this.processVideoInput;
}

export const saveToFileSystem = (path: string) => async (value: WebmOutput) => {
  if (value.saveToFile) {
    await appendFile(path, value.saveToFile);
  } else if (value.eol) {
    const { durationElement } = value.eol;
    const handler = await open(path, "r+");
    await handler.write(
      durationElement,
      0,
      durationElement.length,
      DurationPosition
    );
    const meta = await stat(path);
    const resize = replaceSegmentSize(meta.size);
    await handler.write(resize, 0, resize.length, SegmentSizePosition);

    await handler.close();
  }
};
