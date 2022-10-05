import { TransformStream } from "stream/web";

import { RtpHeader } from "..";
import {
  DepacketizeBase,
  DepacketizerInput,
  DepacketizerOutput,
} from "./depacketizer";

export const depacketizeTransformer = (
  ...args: ConstructorParameters<typeof DepacketizeTransformer>
) => new DepacketizeTransformer(...args).transform;

class DepacketizeTransformer extends DepacketizeBase {
  transform: TransformStream<DepacketizerInput, DepacketizerOutput>;

  constructor(
    codec: string,
    options: {
      waitForKeyframe?: boolean;
      isFinalPacketInSequence?: (header: RtpHeader) => boolean;
    } = {}
  ) {
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
