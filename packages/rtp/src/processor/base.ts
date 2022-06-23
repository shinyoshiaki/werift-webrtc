import { Event } from "rx.mini";

import { RtcpPacket, RtpPacket } from "..";

export abstract class Pipeline {
  protected children?: Pipeline | Output;
  constructor(streams?: {
    rtpStream?: Event<[RtpPacket, any]>;
    rtcpStream?: Event<[RtcpPacket]>;
  }) {
    streams?.rtpStream?.subscribe?.((packet) => {
      this.pushRtpPackets([packet]);
    });
    streams?.rtcpStream?.subscribe?.((packet) => {
      this.pushRtcpPackets([packet]);
    });
  }
  pipe(children: Pipeline | Output): Pipeline | Output {
    this.children = children;
    return this;
  }
  pushRtpPackets(packets: RtpPacket[]) {}
  pushRtcpPackets(packets: RtcpPacket[]) {}
}

export abstract class Output {
  pushRtpPackets?(packets: RtpPacket[]) {}
  pushRtcpPackets?(packets: RtcpPacket[]) {}
}
