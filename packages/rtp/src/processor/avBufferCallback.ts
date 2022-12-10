import { AVBufferBase, AvBufferOptions, AVBufferOutput } from "./avBuffer";

export class AvBufferCallback extends AVBufferBase {
  private audioCb!: (input: AVBufferOutput) => void;
  private videoCb!: (input: AVBufferOutput) => void;
  constructor(options: Partial<AvBufferOptions> = {}) {
    super(
      (output) => {
        if (this.audioCb) {
          this.audioCb(output);
        }
      },
      (output) => {
        if (this.videoCb) {
          this.videoCb(output);
        }
      },
      options
    );
  }

  pipeAudio = (cb: (input: AVBufferOutput) => void) => {
    this.audioCb = cb;
  };
  pipeVideo = (cb: (input: AVBufferOutput) => void) => {
    this.videoCb = cb;
  };

  inputAudio = this.processAudioInput;
  inputVideo = this.processVideoInput;
}
