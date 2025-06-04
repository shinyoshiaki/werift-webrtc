import { SimpleProcessorCallbackBase } from "./interface.js";
import {
  NackHandlerBase,
  type NackHandlerInput,
  type NackHandlerOutput,
} from "./nack.js";

export class NackHandlerCallback extends SimpleProcessorCallbackBase<
  NackHandlerInput,
  NackHandlerOutput,
  typeof NackHandlerBase
>(NackHandlerBase) {}
