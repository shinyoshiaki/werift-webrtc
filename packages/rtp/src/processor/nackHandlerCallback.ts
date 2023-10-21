import { SimpleProcessorCallbackBase } from "./interface";
import { NackHandlerBase, NackHandlerInput, NackHandlerOutput } from "./nack";

export class NackHandlerCallback extends SimpleProcessorCallbackBase<
  NackHandlerInput,
  NackHandlerOutput,
  typeof NackHandlerBase
>(NackHandlerBase) {}
