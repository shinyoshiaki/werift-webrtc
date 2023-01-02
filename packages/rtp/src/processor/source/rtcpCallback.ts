import { RtcpPacket } from "../../rtcp/rtcp";

export interface RtcpOutput {
  rtcp?: RtcpPacket;
  eol?: boolean;
}

export class RtcpSourceCallback {
  private cb?: (chunk: RtcpOutput) => void;

  constructor() {}

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
  }
}
