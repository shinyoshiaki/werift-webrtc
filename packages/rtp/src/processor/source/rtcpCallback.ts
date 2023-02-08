import Event from "rx.mini";

import { RtcpPacket } from "../../rtcp/rtcp";

export interface RtcpOutput {
  rtcp?: RtcpPacket;
  eol?: boolean;
}

export class RtcpSourceCallback {
  private cb?: (chunk: RtcpOutput) => void;

  onStopped = new Event();

  pipe(cb: (chunk: RtcpOutput) => void) {
    this.cb = cb;
  }

  input = (rtcp: RtcpPacket) => {
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
}
