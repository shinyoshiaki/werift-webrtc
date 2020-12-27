export type Kind = "audio" | "video" | "application" | "unknown";

export type SignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "closed";
