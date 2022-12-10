import { SupportedCodec } from "../container/webm";
import { WebmBase, WebmOption, WebmOutput } from "./webm";

export class WebmCallback extends WebmBase {
  private cb!: (input: WebmOutput) => void;
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
          this.cb(output);
        }
      },
      options
    );
  }

  pipe = (cb: (input: WebmOutput) => void) => {
    this.cb = cb;
    this.start();
  };

  inputAudio = this.processAudioInput;
  inputVideo = this.processVideoInput;
}
