import { SimpleProcessorCallback } from "./interface";
import { MuteHandlerBase, MuteInput, MuteOutput } from "./mute";

export class MuteCallback
  extends MuteHandlerBase
  implements SimpleProcessorCallback<MuteInput, MuteOutput>
{
  private cb?: (input: MuteOutput) => void;
  destructor?: () => void;

  constructor(props: ConstructorParameters<typeof MuteHandlerBase>[1]) {
    super((o) => {
      if (this.cb) {
        this.cb(o);
      }
    }, props);
  }

  pipe = (cb: (input: MuteOutput) => void, destructor?: () => void) => {
    this.cb = cb;
    this.destructor = destructor;
    return this;
  };

  input = (input: MuteInput) => {
    for (const output of this.processInput(input)) {
      if (this.cb) {
        this.cb(output);
      }
    }
  };

  destroy = () => {
    if (this.destructor) {
      this.destructor();
      this.destructor = undefined;
    }
    this.cb = undefined;
  };
}
