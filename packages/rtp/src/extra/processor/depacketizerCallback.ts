import {
  DepacketizeBase,
  type DepacketizerInput,
  type DepacketizerOutput,
} from "./depacketizer.js";
import { SimpleProcessorCallbackBase } from "./interface.js";

export class DepacketizeCallback extends SimpleProcessorCallbackBase<
  DepacketizerInput,
  DepacketizerOutput,
  typeof DepacketizeBase
>(DepacketizeBase) {}
