export type Kind = "audio" | "video" | "application" | "unknown";

export const SignalingStates = [
  "stable",
  "have-local-offer",
  "have-remote-offer",
  "have-local-pranswer",
  "have-remote-pranswer",
  "closed",
] as const;

export type RTCSignalingState = (typeof SignalingStates)[number];

export const ConnectionStates = [
  "closed",
  "failed",
  "disconnected",
  "new",
  "connecting",
  "connected",
] as const;

export type ConnectionState = (typeof ConnectionStates)[number];
