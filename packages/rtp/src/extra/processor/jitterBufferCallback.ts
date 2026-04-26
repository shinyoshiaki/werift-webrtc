import { SimpleProcessorCallbackBase } from "./interface";
import {
  JitterBufferBase,
  type JitterBufferInput,
  type JitterBufferOutput,
} from "./jitterBuffer";

export class JitterBufferCallback extends SimpleProcessorCallbackBase<
  JitterBufferInput,
  JitterBufferOutput,
  typeof JitterBufferBase
>(JitterBufferBase) {}
