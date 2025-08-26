import { TransformStream } from "stream/web";

import type { DepacketizerCodec } from "../../codec/index.js";
import {
  DepacketizeBase,
  type DepacketizerInput,
  type DepacketizerOptions,
  type DepacketizerOutput,
} from "./depacketizer.js";

export const depacketizeTransformer = (
  ...args: ConstructorParameters<typeof DepacketizeTransformer>
) => new DepacketizeTransformer(...args).transform;

class DepacketizeTransformer extends DepacketizeBase {
  transform: TransformStream<DepacketizerInput, DepacketizerOutput>;

  constructor(codec: DepacketizerCodec, options: DepacketizerOptions = {}) {
    super(codec, options);

    this.transform = new TransformStream({
      transform: (input, output) => {
        for (const res of this.processInput(input)) {
          output.enqueue(res);
        }
      },
    });
  }
}
