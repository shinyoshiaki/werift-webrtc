import { LipsyncBase, LipSyncOptions, LipsyncOutput } from "./lipsync";

export class LipsyncCallback extends LipsyncBase {
  private audioCb?: (input: LipsyncOutput) => void;
  private videoCb?: (input: LipsyncOutput) => void;
  constructor(options: Partial<LipSyncOptions> = {}) {
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

  pipeAudio = (cb: (input: LipsyncOutput) => void) => {
    this.audioCb = cb;
  };
  pipeVideo = (cb: (input: LipsyncOutput) => void) => {
    this.videoCb = cb;
  };

  inputAudio = this.processAudioInput;
  inputVideo = this.processVideoInput;
}
