import { DtxBase, type DtxInput, type DtxOutput } from "./dtx.js";
import { SimpleProcessorCallbackBase } from "./interface.js";

export class DtxCallback extends SimpleProcessorCallbackBase<
  DtxInput,
  DtxOutput,
  typeof DtxBase
>(DtxBase) {}
