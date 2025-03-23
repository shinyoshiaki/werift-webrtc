import type { RtpRouter } from "../../media";
import type { RTCCertificate } from "../../transport/dtls";
import type { MediaManager } from "../managers/mediaManager";
import type { SctpManager } from "../managers/sctpManager";
import type { PeerConfig } from "../util";

// Interface to expose protected/private properties to managers
export interface PeerConnectionContext {
  router: RtpRouter;
  certificate: RTCCertificate | undefined;
  config: Required<PeerConfig>;
  updateIceGatheringState(): void;
  updateIceConnectionState(): void;
  needNegotiation(): void;
  setLocal(description: any): void; // TODO: Add proper type
  readonly mediaManager: MediaManager;
  readonly sctpManager: SctpManager;
}
