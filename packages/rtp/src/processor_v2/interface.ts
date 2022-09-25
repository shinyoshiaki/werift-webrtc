import { RtpPacket } from "../rtp/rtp";

export interface RtpInput {
  rtp: RtpPacket;
}

export interface RtpOutput {
  rtp?: RtpPacket;
}
