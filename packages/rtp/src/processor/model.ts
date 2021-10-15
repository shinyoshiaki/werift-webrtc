import { Event } from "rx.mini";

import { RtcpPacket, RtpPacket } from "..";

export abstract class Pipeline {
  constructor(streams?: {
    rtpStream: Event<[RtpPacket]>;
    rtcpStream: Event<[RtcpPacket]>;
  }) {}
  pipe(children: Pipeline | Output): Pipeline | Output {
    return {} as any;
  }
  pushRtpPackets(packets: RtpPacket[]) {}
  pushRtcpPackets(packets: RtcpPacket[]) {}
}

export abstract class Output {
  pushRtpPackets?(packets: RtpPacket[]) {}
  pushRtcpPackets?(packets: RtcpPacket[]) {}
}
