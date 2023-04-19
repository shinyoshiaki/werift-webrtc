import { MuteHandlerBase, MuteInput, MuteOutput } from "./mute";

export class MuteCallback extends MuteHandlerBase {
  private cb?: (input: MuteOutput) => void;

  constructor(props: ConstructorParameters<typeof MuteHandlerBase>[1]) {
    super((o) => {
      if (this.cb) {
        this.cb(o);
      }
    }, props);
  }

  pipe = (cb: (input: MuteOutput) => void) => {
    this.cb = cb;
  };

  input = (input: MuteInput) => {
    for (const output of this.processInput(input)) {
      if (this.cb) {
        this.cb(output);
      }
    }
  };
}
