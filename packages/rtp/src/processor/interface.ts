export interface Processor<Input, Output> {
  processInput: (input: Input) => Output[];
  toJSON(): Record<string, any>;
}

export interface AVProcessor<Input> {
  processAudioInput: (input: Input) => void;
  processVideoInput: (input: Input) => void;
  toJSON(): Record<string, any>;
}
