import { OverconstrainedError as WeriftOverconstrainedError } from "../errors";

export type { RTCPeerConnectionConfig } from "../peerConnection";
// The core class: `instanceof` holds for descriptions werift creates too.
export type { RTCSdpType, RTCSessionDescriptionInit } from "../sdp";
export { RTCSessionDescription } from "../sdp";
export type { InstallPolyfillOptions } from "./install";
export { installPolyfill } from "./install";
export type {
  BoundMediaRegister,
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
  MediaStreamConstraints,
  MediaTrackConstraints,
} from "./mediaRegister";
export {
  createPolyfillRTCPeerConnection,
  mergePeerConnectionConfig,
} from "./peerConnectionConfig";
export {
  createCallbackRegister,
  createDummyRegister,
} from "./registers/callback";
export { createEmptyRegister } from "./registers/empty";
export type {
  CreateMp4WebmRegisterOptions,
  Mp4WebmCodecHint,
} from "./registers/mp4Webm";
export { createMp4WebmRegister } from "./registers/mp4Webm";
export type {
  CreateEncodedBinaryRegisterOptions,
  CreateRtpRtcpRegisterOptions,
} from "./registers/rtpRtcp";
export {
  createEncodedBinaryRegister,
  createRtpRtcpRegister,
} from "./registers/rtpRtcp";
export { WeriftOverconstrainedError as OverconstrainedError };
