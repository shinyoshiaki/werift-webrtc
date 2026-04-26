import { SimpleProcessorCallbackBase } from "./interface";
import {
  NackHandlerBase,
  type NackHandlerInput,
  type NackHandlerOutput,
} from "./nack";

export class NackHandlerCallback extends SimpleProcessorCallbackBase<
  NackHandlerInput,
  NackHandlerOutput,
  typeof NackHandlerBase
>(NackHandlerBase) {}
