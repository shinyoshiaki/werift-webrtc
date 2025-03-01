import type { RtpRouter } from "../../media";
import type { RTCCertificate } from "../../transport/dtls";
import type { PeerConfig } from "../util";
import type { MediaManager } from "../managers/mediaManager";
import type { SctpManager } from "../managers/sctpManager";

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
