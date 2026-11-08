import { TransformStream } from "stream/web";

import {
  JitterBufferBase,
  type JitterBufferInput,
  type JitterBufferOptions,
  type JitterBufferOutput,
} from "./jitterBuffer";

export const jitterBufferTransformer = (
  ...args: ConstructorParameters<typeof JitterBufferTransformer>
) => new JitterBufferTransformer(...args).transform;

export class JitterBufferTransformer extends JitterBufferBase {
  public clockRate: number;

  transform: TransformStream<JitterBufferInput, JitterBufferOutput>;

  constructor(clockRate: number, options: Partial<JitterBufferOptions> = {}) {
    super(clockRate, options);
    this.clockRate = clockRate;

    this.transform = new TransformStream({
      transform: (input, output) => {
        for (const res of this.processInput(input)) {
          output.enqueue(res);
        }
      },
    });
  }
}
