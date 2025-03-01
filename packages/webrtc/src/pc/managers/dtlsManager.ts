import { debug } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import { RTCDtlsTransport } from "../../transport/dtls";
import { RTCIceGatherer, RTCIceTransport } from "../../transport/ice";
import { parseIceServers } from "../../utils";
import type { BaseManager } from "../types/manager";
import type { PeerConnectionContext } from "../types/peerConnectionContext";

const log = debug("werift:webrtc/dtlsManager");

export class DtlsManager implements BaseManager {
  constructor(public readonly context: PeerConnectionContext) {}

  createTransport(srtpProfiles: SrtpProfile[] = []): RTCDtlsTransport {
    const [existing] = this.context.connection.iceTransports;

    // Gather ICE candidates for only one track. If the remote endpoint is not bundle-aware, negotiate only one media track.
    // https://w3c.github.io/webrtc-pc/#rtcbundlepolicy-enum
    if (this.context.config.bundlePolicy === "max-bundle" && existing) {
      return this.context.connection.dtlsTransports[0];
    }

    const iceGatherer = this.createIceGatherer(existing);
    const iceTransport = this.createIceTransport(iceGatherer);

    const dtlsTransport = new RTCDtlsTransport(
      this.context.config,
      iceTransport,
      this.context.router,
      this.context.certificate,
      srtpProfiles,
    );

    return dtlsTransport;
  }

  private createIceGatherer(existing?: RTCIceTransport): RTCIceGatherer {
    const iceGatherer = new RTCIceGatherer({
      ...parseIceServers(this.context.config.iceServers),
      forceTurn: this.context.config.iceTransportPolicy === "relay",
      portRange: this.context.config.icePortRange,
      interfaceAddresses: this.context.config.iceInterfaceAddresses,
      additionalHostAddresses: this.context.config.iceAdditionalHostAddresses,
      filterStunResponse: this.context.config.iceFilterStunResponse,
      filterCandidatePair: this.context.config.iceFilterCandidatePair,
      localPasswordPrefix: this.context.config.icePasswordPrefix,
      useIpv4: this.context.config.iceUseIpv4,
      useIpv6: this.context.config.iceUseIpv6,
      turnTransport: this.context.config.forceTurnTCP === true ? "tcp" : "udp",
      useLinkLocalAddress: this.context.config.iceUseLinkLocalAddress,
    });

    if (existing) {
      iceGatherer.connection.localUsername = existing.connection.localUsername;
      iceGatherer.connection.localPassword = existing.connection.localPassword;
    }

    iceGatherer.onGatheringStateChange.subscribe(() => {
      this.context.updateIceGatheringState();
    });

    return iceGatherer;
  }

  private createIceTransport(iceGatherer: RTCIceGatherer): RTCIceTransport {
    const iceTransport = new RTCIceTransport(iceGatherer);

    iceTransport.onStateChange.subscribe(() => {
      this.context.updateIceConnectionState();
    });

    iceTransport.onNegotiationNeeded.subscribe(() => {
      this.context.needNegotiation();
    });

    iceTransport.onIceCandidate.subscribe((candidate) => {
      const pc = this.context.connection;
      if (!pc._localDescription) {
        log("localDescription not found when ice candidate was gathered");
        return;
      }

      if (!candidate) {
        this.context.setLocal(pc._localDescription);
        pc.onIceCandidate.execute(undefined);
        if (pc.onicecandidate) {
          pc.onicecandidate({ candidate: undefined });
        }
        pc.emit("icecandidate", { candidate: undefined });
        return;
      }

      if (
        this.context.config.bundlePolicy === "max-bundle" ||
        pc.remoteIsBundled
      ) {
        candidate.sdpMLineIndex = 0;
        const media = pc._localDescription?.media[0];
        if (media) {
          candidate.sdpMid = media.rtp.muxId;
        }
      } else {
        const transceiver = pc.transceivers.find(
          (t) => t.dtlsTransport.iceTransport.id === iceTransport.id,
        );
        if (transceiver) {
          candidate.sdpMLineIndex = transceiver.mLineIndex;
          candidate.sdpMid = transceiver.mid;
        }
        if (
          pc.sctpTransport?.dtlsTransport.iceTransport.id === iceTransport.id
        ) {
          candidate.sdpMLineIndex = pc.sctpTransport.mLineIndex;
          candidate.sdpMid = pc.sctpTransport.mid;
        }
      }

      candidate.foundation = "candidate:" + candidate.foundation;

      pc.onIceCandidate.execute(candidate.toJSON());
      if (pc.onicecandidate) {
        pc.onicecandidate({ candidate: candidate.toJSON() });
      }
      pc.emit("icecandidate", { candidate });
    });

    return iceTransport;
  }

  async ensureCertificates() {
    if (!this.context.certificate) {
      this.context.certificate = await RTCDtlsTransport.SetupCertificate();
    }

    for (const dtlsTransport of this.context.connection.dtlsTransports) {
      dtlsTransport.localCertificate = this.context.certificate;
    }
  }

  dispose() {
    // Cleanup any DTLS-specific resources if needed
  }
}
