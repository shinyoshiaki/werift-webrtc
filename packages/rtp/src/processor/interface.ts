export interface Processor<Input, Output> {
  processInput: (input: Input) => Output[];
}

export interface AVProcessor<Input> {
  processAudioInput: (input: Input) => void;
  processVideoInput: (input: Input) => void;
}
