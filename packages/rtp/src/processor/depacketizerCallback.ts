import { RtpHeader } from "..";
import {
  DepacketizeBase,
  DepacketizerInput,
  DepacketizerOutput,
} from "./depacketizer";

export class DepacketizeCallback extends DepacketizeBase {
  private cb!: (input: DepacketizerOutput) => void;

  constructor(
    codec: string,
    options: {
      waitForKeyframe?: boolean;
      isFinalPacketInSequence?: (header: RtpHeader) => boolean;
    } = {}
  ) {
    super(codec, options);
  }

  pipe = (cb: (input: DepacketizerOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: DepacketizerInput) => {
    for (const output of this.processInput(input)) {
      this.cb(output);
    }
  };
}
