import { NtpTimeBase, NtpTimeInput, NtpTimeOutput } from "./ntpTime";

export class NtpTimeCallback extends NtpTimeBase {
  private cb!: (input: NtpTimeOutput) => void;

  constructor(clockRate: number) {
    super(clockRate);
  }

  pipe = (cb: (input: NtpTimeOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: NtpTimeInput) => {
    for (const output of this.processInput(input)) {
      this.cb(output);
    }
  };
}
