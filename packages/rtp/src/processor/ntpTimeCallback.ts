import { NtpTimeBase, NtpTimeInput, NtpTimeOutput } from "./ntpTime";

export class NtpTimeCallback extends NtpTimeBase {
  private cb?: (input: NtpTimeOutput) => void;

  pipe = (cb: (input: NtpTimeOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: NtpTimeInput) => {
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
