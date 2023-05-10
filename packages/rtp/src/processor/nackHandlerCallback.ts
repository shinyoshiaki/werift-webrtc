import { RtcpTransportLayerFeedback } from "../rtcp/rtpfb";
import { NackHandlerBase, NackHandlerInput, NackHandlerOutput } from "./nack";

export class NackHandlerCallback extends NackHandlerBase {
  private cb?: (input: NackHandlerOutput) => void;
  constructor(
    senderSsrc: number,
    onNack: (rtcp: RtcpTransportLayerFeedback) => Promise<void>
  ) {
    super(senderSsrc, onNack);
  }

  pipe = (cb: (input: NackHandlerOutput) => void) => {
    this.cb = cb;
    return this;
  };

  input = (input: NackHandlerInput) => {
    for (const output of this.processInput(input)) {
      if (this.cb) {
        this.cb(output);
      }
    }
    if (input.eol) {
      this.cb = undefined;
    }
  };
}
