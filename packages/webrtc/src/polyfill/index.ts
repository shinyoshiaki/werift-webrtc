import { OverconstrainedError as WeriftOverconstrainedError } from "../errors";
import type { Event } from "../imports/common";
import type { Extensions, RtcpPacket, RtpPacket } from "../imports/rtp";

export type {
  BoundMediaRegister,
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
  MediaStreamConstraints,
  MediaTrackConstraints,
} from "./mediaRegister";
export { installPolyfill } from "./install";
export type { InstallPolyfillOptions } from "./install";
export {
  createCallbackRegister,
  createDummyRegister,
} from "./registers/callback";
export { createMp4WebmRegister } from "./registers/mp4Webm";
export type { CreateMp4WebmRegisterOptions } from "./registers/mp4Webm";
export {
  createEncodedBinaryRegister,
  createRtpRtcpRegister,
} from "./registers/rtpRtcp";
export type {
  CreateEncodedBinaryRegisterOptions,
  CreateRtpRtcpRegisterOptions,
} from "./registers/rtpRtcp";
export { PolyfillRTCSessionDescription as RTCSessionDescription } from "./rtcSessionDescription";
export { WeriftOverconstrainedError as OverconstrainedError };

declare global {
  interface MediaStreamTrack {
    writeRtp(rtp: RtpPacket | Buffer): void;
    readonly onReceiveRtp: Event<[RtpPacket, Extensions?]>;
    readonly onReceiveRtcp: Event<[RtcpPacket]>;
  }
}
