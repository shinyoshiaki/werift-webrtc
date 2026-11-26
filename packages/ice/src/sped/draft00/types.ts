export type SpedState =
  | "disabled"
  | "probing"
  | "active"
  | "fallback"
  | "complete";

export type SpedPeerSupport = "unknown" | "supported" | "unsupported";

export type SpedDecodedData =
  | { kind: "empty" }
  | { kind: "datagram"; bytes: Buffer }
  | { kind: "invalid-demux" };

export type SpedDecodedAck =
  | { kind: "ignore" }
  | { kind: "crcs"; crcs: number[] };
