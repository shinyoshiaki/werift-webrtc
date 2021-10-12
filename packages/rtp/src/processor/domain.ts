import { RtcpPacket, RtpPacket } from "..";

export abstract class Pipeline {
  pipe(children: Pipeline) {}
  pushRtpPackets(packets: RtpPacket[]) {}
  pushRtcpPackets(packets: RtcpPacket[]) {}
}
