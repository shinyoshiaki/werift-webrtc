import type { RtpRouter } from "../media";
import type { RTCCertificate } from "../transport/dtls";
import type { SessionDescription } from "../sdp";
import type { RTCPeerConnection } from "./pc";
import type { PeerConnectionContext } from "./types/peerConnectionContext";
import type { PeerConfig } from "./util";

export class RTCPeerConnectionContext implements PeerConnectionContext {
  constructor(
    public readonly connection: RTCPeerConnection,
    private readonly pc: {
      config: Required<PeerConfig>;
      router: RtpRouter;
      certificate?: RTCCertificate;
      updateIceGatheringState(): void;
      updateIceConnectionState(): void;
      needNegotiation(): void;
      setLocal(description: SessionDescription): void;
    },
  ) {}

  get config(): Required<PeerConfig> {
    return this.pc.config;
  }

  get router(): RtpRouter {
    return this.pc.router;
  }

  get certificate(): RTCCertificate | undefined {
    return this.pc.certificate;
  }

  set certificate(certificate: RTCCertificate | undefined) {
    (this.pc as any).certificate = certificate;
  }

  updateIceGatheringState(): void {
    this.pc.updateIceGatheringState();
  }

  updateIceConnectionState(): void {
    this.pc.updateIceConnectionState();
  }

  needNegotiation(): void {
    this.pc.needNegotiation();
  }

  setLocal(description: SessionDescription): void {
    this.pc.setLocal(description);
  }
}
