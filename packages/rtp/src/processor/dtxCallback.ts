import { DtxBase, DtxInput, DtxOutput } from "./dtx";

export class DtxCallback extends DtxBase {
  private cb!: (input: DtxOutput) => void;

  pipe = (cb: (input: DtxOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: DtxInput) => {
    for (const output of this.processInput(input)) {
      this.cb(output);
    }
  };
}
