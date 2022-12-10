import {
  JitterBufferBase,
  JitterBufferInput,
  JitterBufferOptions,
  JitterBufferOutput,
} from "./jitterBuffer";

export class JitterBufferCallback extends JitterBufferBase {
  private cb!: (input: JitterBufferOutput) => void;
  constructor(
    public clockRate: number,
    options: Partial<JitterBufferOptions> = {}
  ) {
    super(clockRate, options);
  }

  pipe = (cb: (input: JitterBufferOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: JitterBufferInput) => {
    for (const output of this.processInput(input)) {
      this.cb(output);
    }
  };
}
