import { SimpleProcessorCallbackBase } from "./interface.js";
import {
  JitterBufferBase,
  type JitterBufferInput,
  type JitterBufferOutput,
} from "./jitterBuffer.js";

export class JitterBufferCallback extends SimpleProcessorCallbackBase<
  JitterBufferInput,
  JitterBufferOutput,
  typeof JitterBufferBase
>(JitterBufferBase) {}
