import { SimpleProcessorCallbackBase } from "./interface";
import {
  JitterBufferBase,
  JitterBufferInput,
  JitterBufferOutput,
} from "./jitterBuffer";

export class JitterBufferCallback extends SimpleProcessorCallbackBase<
  JitterBufferInput,
  JitterBufferOutput,
  typeof JitterBufferBase
>(JitterBufferBase) {}
