import {
  LipsyncBase,
  LipsyncInput,
  LipSyncOptions,
  LipsyncOutput,
} from "./lipsync";

export class LipsyncCallback extends LipsyncBase {
  private audioCb?: (input: LipsyncOutput) => void;
  private audioDestructor?: () => void;
  private videoCb?: (input: LipsyncOutput) => void;
  private videoDestructor?: () => void;
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
      options,
    );
  }

  pipeAudio = (cb: (input: LipsyncOutput) => void, destructor?: () => void) => {
    this.audioCb = cb;
    this.audioDestructor = destructor;
  };
  pipeVideo = (cb: (input: LipsyncOutput) => void, destructor?: () => void) => {
    this.videoCb = cb;
    this.videoDestructor = destructor;
  };

  inputAudio = (input: LipsyncInput) => {
    this.processAudioInput(input);
  };
  inputVideo = (input: LipsyncInput) => {
    this.processVideoInput(input);
  };

  destroy = () => {
    if (this.audioDestructor) {
      this.audioDestructor();
      this.audioDestructor = undefined;
    }
    if (this.videoDestructor) {
      this.videoDestructor();
      this.videoDestructor = undefined;
    }
    this.audioCb = undefined;
    this.videoCb = undefined;
  };
}
