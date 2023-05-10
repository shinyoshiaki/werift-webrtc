import Event from "rx.mini";

import { RtcpPacket } from "../rtcp/rtcp";
import { SimpleProcessorCallback } from "./interface";

export type RtcpInput = RtcpPacket;

export interface RtcpOutput {
  rtcp?: RtcpPacket;
  eol?: boolean;
}

export class RtcpSourceCallback
  implements SimpleProcessorCallback<RtcpInput, RtcpOutput>
{
  private cb?: (chunk: RtcpOutput) => void;
  private destructor?: () => void;
  onStopped = new Event();

  pipe(cb: (chunk: RtcpOutput) => void, destructor?: () => void) {
    this.cb = cb;
    this.destructor = destructor;
    return this;
  }

  input = (rtcp: RtcpInput) => {
    if (this.cb) {
      this.cb({ rtcp });
    }
  };

  stop() {
    if (this.cb) {
      this.cb({ eol: true });
    }
    this.onStopped.execute();
  }

  destroy = () => {
    if (this.destructor) {
      this.destructor();
      this.destructor = undefined;
    }
    this.cb = undefined;
    this.onStopped.allUnsubscribe();
  };
}
