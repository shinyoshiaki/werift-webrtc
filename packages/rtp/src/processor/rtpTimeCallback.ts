import { RtpTimeBase, RtpTimeInput, RtpTimeOutput } from "./rtpTime";

export class RtpTimeCallback extends RtpTimeBase {
  private cb?: (input: RtpTimeOutput) => void;

  constructor(clockRate: number) {
    super(clockRate);
  }

  pipe = (cb: (input: RtpTimeOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: RtpTimeInput) => {
    for (const output of this.processInput(input)) {
      if (this.cb) {
        this.cb(output);
      }
    }
    if (input.eol) {
      this.cb = undefined;
    }
  };
}
