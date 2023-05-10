import {
  DepacketizeBase,
  DepacketizerInput,
  DepacketizerOutput,
} from "./depacketizer";
import { SimpleProcessorCallbackBase } from "./interface";

export class DepacketizeCallback extends SimpleProcessorCallbackBase<
  DepacketizerInput,
  DepacketizerOutput,
  typeof DepacketizeBase
>(DepacketizeBase) {}
