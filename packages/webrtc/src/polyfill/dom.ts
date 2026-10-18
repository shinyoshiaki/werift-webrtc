import type { Event } from "../imports/common";
import type { Extensions, RtcpPacket, RtpPacket } from "../imports/rtp";

export * from "./api";

declare global {
  interface MediaStreamTrack {
    writeRtp(rtp: RtpPacket | Buffer): void;
    writeRtcp(rtcp: RtcpPacket): void;
    readonly onReceiveRtp: Event<[RtpPacket, Extensions?]>;
    readonly onReceiveRtcp: Event<[RtcpPacket]>;
  }
}
