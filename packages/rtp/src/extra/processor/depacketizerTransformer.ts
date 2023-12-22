import { TransformStream } from "stream/web";

import { DepacketizerCodec } from "../../codec";
import {
  DepacketizeBase,
  DepacketizerInput,
  DepacketizerOptions,
  DepacketizerOutput,
} from "./depacketizer";

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
