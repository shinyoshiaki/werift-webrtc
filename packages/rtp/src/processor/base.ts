import Event from "rx.mini";

import { RtcpPacket, RtpPacket } from "..";

export abstract class Pipeline {
  protected children?: Pipeline | Output;
  private disposer?: () => void;

  constructor(streams?: {
    rtpStream?: Event<[RtpPacket]>;
    rtcpStream?: Event<[RtcpPacket]>;
  }) {
    const disposers: ((() => void) | undefined)[] = [];
    {
      const { unSubscribe } =
        streams?.rtpStream?.subscribe?.((packet) => {
          this.pushRtpPackets([packet]);
        }) ?? {};
      disposers.push(unSubscribe);
    }
    {
      const { unSubscribe } =
        streams?.rtcpStream?.subscribe?.((packet) => {
          this.pushRtcpPackets([packet]);
        }) ?? {};
      disposers.push(unSubscribe);
    }
    this.disposer = () => {
      disposers.forEach((d) => d?.());
    };
  }
  pipe(children: Pipeline | Output): Pipeline | Output {
    this.children = children;
    return this;
  }
  pushRtpPackets(packets: RtpPacket[]) {}
  pushRtcpPackets(packets: RtcpPacket[]) {}
  stop() {
    this.disposer?.();
  }
}

export abstract class Output {
  pushRtpPackets?(packets: RtpPacket[]) {}
  pushRtcpPackets?(packets: RtcpPacket[]) {}
}
