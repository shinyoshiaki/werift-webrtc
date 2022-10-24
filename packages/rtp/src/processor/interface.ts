export interface Processor<Input, Output> {
  processInput: (input: Input) => Output[];
}
