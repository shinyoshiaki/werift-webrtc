import { OverconstrainedError as WeriftOverconstrainedError } from "../errors";

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
export type {
  CreateMp4WebmRegisterOptions,
  Mp4WebmCodecHint,
} from "./registers/mp4Webm";
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
