import {
  JitterBufferBase,
  JitterBufferInput,
  JitterBufferOutput,
} from "./jitterBuffer";

export class JitterBufferCallback extends JitterBufferBase {
  private cb?: (input: JitterBufferOutput) => void;

  pipe = (cb: (input: JitterBufferOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: JitterBufferInput) => {
    if (!this.cb) {
      return;
    }
    for (const output of this.processInput(input)) {
      this.cb(output);
    }
    if (input.eol) {
      this.cb = undefined;
    }
  };
}
