import type { DtlsVersion } from "../imports/dtls";
import type { DebugConfig } from "../peerConnection";

export interface DtlsTransportConfig {
  debug?: DebugConfig;
  protocolVersions?: readonly DtlsVersion[];
  helloRetryRequest?: boolean;
  warp?: {
    allowEarlyServerData?: boolean;
    earlyMediaPolicy?: "drop" | "buffer";
  };
}

export interface DtlsTransportStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

export const DtlsStates = [
  "new",
  "connecting",
  "connected",
  "closed",
  "failed",
] as const;
export type DtlsState = (typeof DtlsStates)[number];

export type DtlsRole = "auto" | "server" | "client";

/** @internal */
export interface WebRtcDtlsReadiness {
  writeReady: boolean;
  peerAuthenticated: boolean;
  handshakeComplete: boolean;
}

/** @internal */
export interface TransportAttempt {
  readonly id: number;
  readonly iceGeneration: number;
}
