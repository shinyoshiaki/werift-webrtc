export interface Processor<Input, Output> {
  processInput: (input: Input) => Output[];
  toJSON(): Record<string, any>;
}

export interface AVProcessor<Input> {
  processAudioInput: (input: Input) => void;
  processVideoInput: (input: Input) => void;
  toJSON(): Record<string, any>;
}

export interface SimpleProcessorCallback<Input = any, Output = any> {
  pipe: (
    cb: (o: Output) => void,
    destructor?: () => void
  ) => SimpleProcessorCallback<Input, Output>;
  input: (input: Input) => void;
  destroy: () => void;
}

export const SimpleProcessorCallbackBase = <
  Input,
  Output,
  TBase extends new (...args: any[]) => Processor<Input, Output>
>(
  Base: TBase
) => {
  return class extends Base implements SimpleProcessorCallback<Input, Output> {
    _cb?: (o: Output) => void;
    _destructor?: () => void;

    pipe = (cb: (o: Output) => void, destructor?: () => void) => {
      this._cb = cb;
      this._destructor = destructor;
      cb = undefined as any;
      destructor = undefined;
      return this;
    };

    input = (input: Input) => {
      for (const output of this.processInput(input)) {
        if (this._cb) {
          this._cb(output);
        }
      }
    };

    destroy = () => {
      if (this._destructor) {
        this._destructor();
        this._destructor = undefined;
      }
      this._cb = undefined;
    };
  };
};
