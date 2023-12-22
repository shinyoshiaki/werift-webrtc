import { TransformStream } from "stream/web";

import {
  JitterBufferBase,
  JitterBufferInput,
  JitterBufferOptions,
  JitterBufferOutput,
} from "./jitterBuffer";

export const jitterBufferTransformer = (
  ...args: ConstructorParameters<typeof JitterBufferTransformer>
) => new JitterBufferTransformer(...args).transform;

export class JitterBufferTransformer extends JitterBufferBase {
  transform: TransformStream<JitterBufferInput, JitterBufferOutput>;

  constructor(
    public clockRate: number,
    options: Partial<JitterBufferOptions> = {},
  ) {
    super(clockRate, options);

    this.transform = new TransformStream({
      transform: (input, output) => {
        for (const res of this.processInput(input)) {
          output.enqueue(res);
        }
      },
    });
  }
}
