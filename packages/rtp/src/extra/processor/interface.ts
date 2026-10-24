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
    destructor?: () => void,
  ) => SimpleProcessorCallback<Input, Output>;
  input: (input: Input) => void;
  destroy: () => void;
  toJSON(): Record<string, any>;
}

/**
 * Instance shape added by {@link SimpleProcessorCallbackBase}.
 * `this` is only legal inside a named interface, so the factory's declaration
 * stays valid for consumers (skipLibCheck: false) and `pipe` keeps returning
 * the derived class type.
 */
export interface SimpleProcessorCallbackMixin<Input, Output> {
  cb?: (o: Output) => void;
  destructor?: () => void;
  pipe: (cb: (o: Output) => void, destructor?: () => void) => this;
  input: (input: Input) => void;
  destroy: () => void;
  processInput: (input: Input) => Output[];
  toJSON(): Record<string, any>;
}

export const SimpleProcessorCallbackBase = <
  Input,
  Output,
  TBase extends new (
    ...args: any[]
  ) => Processor<Input, Output>,
>(
  Base: TBase,
): (new (
  ...args: any[]
) => SimpleProcessorCallbackMixin<Input, Output>) &
  TBase => {
  return class extends Base implements SimpleProcessorCallback<Input, Output> {
    cb?: (o: Output) => void;
    destructor?: () => void;

    pipe = (cb: (o: Output) => void, destructor?: () => void) => {
      this.cb = cb;
      this.destructor = destructor;
      cb = undefined as any;
      destructor = undefined;
      return this;
    };

    input = (input: Input) => {
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
  };
};
