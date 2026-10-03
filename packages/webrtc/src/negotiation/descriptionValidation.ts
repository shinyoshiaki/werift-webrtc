import { SCTP_STATE } from "../../../sctp/src";
import type { PeerConfig } from "../api/peerConfig";
import { createWebRtcDomException } from "../errors";
import { type TransceiverManager, negotiateRemoteCodecs } from "../media";
import type { NegotiationTransaction } from "../negotiationTransaction";
import type { SctpTransportManager } from "../sctpManager";
import type { MediaDescription, SessionDescription } from "../sdp";
import type { SDPManager } from "../sdpManager";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { RTCSignalingState } from "../types/domain";
import type { BundleTopology } from "./bundleTopology";

function fingerprintKey(params: NonNullable<MediaDescription["dtlsParams"]>) {
  return params.fingerprints
    .map(
      ({ algorithm, value }) =>
        `${algorithm.toLowerCase()}:${value.replaceAll(":", "").toLowerCase()}`,
    )
    .sort()
    .join("|");
}

/**
 * Validation of a description before any transaction or live state changes.
 * A description that fails here leaves the signaling state, both
 * descriptions and every transport as they were.
 */
export class DescriptionValidation {
  constructor(
    private readonly config: PeerConfig,
    private readonly sdp: SDPManager,
    private readonly transceivers: TransceiverManager,
    private readonly sctp: SctpTransportManager,
    private readonly negotiation: NegotiationTransaction,
    private readonly topology: BundleTopology,
  ) {}

  /**
   * A local description must use the ICE credentials of the transports
   * prepared for it and keep the DTLS role of a live association.
   */
  validateLocal(description: SessionDescription) {
    for (const media of description.media) {
      if (media.port === 0 || !media.iceParams) continue;
      const prepared =
        media.rtp.muxId && this.negotiation.transportByMid.get(media.rtp.muxId);
      const live =
        media.kind === "application"
          ? this.sctp.sctpTransport?.dtlsTransport
          : this.transceivers
              .getTransceivers()
              .find((transceiver) => transceiver.mid === media.rtp.muxId)
              ?.dtlsTransport;
      const matches = (transport?: RTCDtlsTransport) =>
        transport?.iceTransport.localParameters.usernameFragment ===
          media.iceParams!.usernameFragment &&
        transport.iceTransport.localParameters.password ===
          media.iceParams!.password;
      // An answer must use the transport prepared for it. A (replacement)
      // offer is built from the live transports; re-applying the previous
      // pending offer may carry its prepared credentials instead.
      const acceptable =
        description.type === "offer"
          ? [prepared, live].filter(Boolean)
          : [prepared || live].filter(Boolean);
      if (
        acceptable.length > 0 &&
        !acceptable.some((transport) => matches(transport || undefined))
      ) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Local SDP must use prepared ICE credentials",
        );
      }
      // Like a remote one, a local answer or pranswer keeps the DTLS role
      // of a live association (RFC 8842 section 5.5); an edited a=setup is
      // refused before it can change the running transport.
      const bundledNonTag = this.topology.isBundledNonTag(
        description,
        media.rtp.muxId,
      );
      const localRole = media.dtlsParams?.role;
      if (
        description.type !== "offer" &&
        !bundledNonTag &&
        localRole &&
        localRole !== "auto" &&
        live &&
        (!prepared || prepared === live) &&
        ["connecting", "connected"].includes(live.state) &&
        live.role !== "auto" &&
        live.role !== localRole
      ) {
        throw createWebRtcDomException(
          "InvalidModificationError",
          "Changing the DTLS role of a connected association is unsupported",
        );
      }
    }
  }

  /**
   * A remote description: common codecs with the pending local offer, shared
   * transports, media kinds, SCTP port, codecs, DTLS fingerprint and role, and
   * SCTP binding are all checked before any state changes.
   */
  validateRemote(
    remoteSdp: SessionDescription,
    signalingState: RTCSignalingState,
  ) {
    this.sdp.validateRemoteDescription(remoteSdp);
    this.topology.assertAnswerKeepsSharedTransports(remoteSdp, signalingState);
    for (const [mediaIndex, media] of remoteSdp.media.entries()) {
      if (!["audio", "video", "application"].includes(media.kind)) {
        throw createWebRtcDomException(
          "OperationError",
          "Unsupported media kind",
        );
      }
      if (media.kind === "application" && media.port !== 0) {
        if (!media.sctpPort || media.sctpPort < 1 || media.sctpPort > 65535) {
          throw createWebRtcDomException("OperationError", "Invalid SCTP port");
        }
        if (
          this.sctp.sctpRemotePort &&
          this.sctp.sctpRemotePort !== media.sctpPort
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Changing the port of an existing SCTP association is unsupported",
          );
        }
      }
      if (
        remoteSdp.type !== "offer" &&
        media.port !== 0 &&
        media.kind !== "application" &&
        negotiateRemoteCodecs(
          this.transceivers
            .getTransceivers()
            .find((transceiver) => transceiver.mid === media.rtp.muxId)
            ?.pendingLocalOfferCodecs ?? this.localCodecsFor(media),
          media,
        ).length === 0
      ) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          "No supported codec in answer",
        );
      }
      if (media.port !== 0 && this.sdp.currentRemoteDescription) {
        const currentMedia =
          this.sdp.currentRemoteDescription.media[mediaIndex];
        const transport =
          media.kind === "application"
            ? this.sctp.sctpTransport?.dtlsTransport
            : this.transceivers
                .getTransceivers()
                .find((t) => t.mid === media.rtp.muxId)?.dtlsTransport;
        if (
          transport?.state === "connected" &&
          currentMedia?.dtlsParams &&
          media.dtlsParams
        ) {
          if (
            fingerprintKey(currentMedia.dtlsParams) !==
            fingerprintKey(media.dtlsParams)
          ) {
            throw createWebRtcDomException(
              "InvalidModificationError",
              "Changing the fingerprint of a connected DTLS association is unsupported",
            );
          }
        }
        // An answer or pranswer keeps the DTLS role of a live association
        // (RFC 8842 section 5.5); only a new association, such as a BUNDLE
        // split owner prepared for this proposal, may take another role.
        // A non-tag BUNDLE member never sets a role, so it is not checked.
        const prepared = this.negotiation.transportByMid.get(
          media.rtp.muxId ?? "",
        );
        const bundledNonTag = this.topology.isBundledNonTag(
          remoteSdp,
          media.rtp.muxId,
        );
        const remoteRole = media.dtlsParams?.role;
        if (
          remoteSdp.type !== "offer" &&
          !bundledNonTag &&
          remoteRole &&
          transport &&
          ["connecting", "connected"].includes(transport.state) &&
          transport.role !== "auto" &&
          (!prepared || prepared === transport) &&
          (remoteRole === "client" ? "server" : "client") !== transport.role
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Changing the DTLS role of a connected association is unsupported",
          );
        }
      }
      if (
        media.port !== 0 &&
        this.sdp.pendingRemoteDescription?.type === "pranswer" &&
        !this.sdp.currentRemoteDescription
      ) {
        const provisional = this.sdp.pendingRemoteDescription.media[mediaIndex];
        const transport =
          media.kind === "application"
            ? this.sctp.sctpTransport?.dtlsTransport
            : this.transceivers
                .getTransceivers()
                .find((transceiver) => transceiver.mid === media.rtp.muxId)
                ?.dtlsTransport;
        if (
          transport?.state === "connected" &&
          provisional?.dtlsParams &&
          media.dtlsParams &&
          fingerprintKey(provisional.dtlsParams) !==
            fingerprintKey(media.dtlsParams)
        ) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Changing the fingerprint of a provisional DTLS association is unsupported",
          );
        }
      }
    }
    if (
      remoteSdp.type === "answer" &&
      this.sctp.sctpTransport?.sctp?.associationState === SCTP_STATE.ESTABLISHED
    ) {
      const application = remoteSdp.media.find(
        (media) => media.kind === "application" && media.port !== 0,
      );
      if (application?.rtp.muxId) {
        const bundle = remoteSdp.group.find(
          (group) =>
            group.semantic === "BUNDLE" &&
            group.items.includes(application.rtp.muxId!),
        );
        const owner = bundle?.items[0] ?? application.rtp.muxId;
        const desired =
          this.negotiation.transportByMid.get(owner) ??
          this.transceivers
            .getTransceivers()
            .find((transceiver) => transceiver.mid === owner)?.dtlsTransport ??
          (this.sctp.sctpTransport.mid === owner
            ? this.sctp.sctpTransport.dtlsTransport
            : undefined);
        if (desired && desired !== this.sctp.sctpTransport.dtlsTransport) {
          throw createWebRtcDomException(
            "InvalidModificationError",
            "Moving a connected SCTP association to another DTLS transport is unsupported",
          );
        }
      }
    }

    if (remoteSdp.type === "offer") {
      // Checked before a replacement retires the previous pending offer.
      this.topology.assertPendingSctpBinding(remoteSdp);
    }
  }

  /**
   * Local codecs `setRemoteRTP` will negotiate an m-line against, including a
   * sender track codec it adopts, without mutating the configuration.
   */
  private localCodecsFor(media: MediaDescription) {
    const kind = media.kind as "audio" | "video";
    const trackCodec = this.transceivers
      .getTransceivers()
      .find((t) => t.mid === media.rtp.muxId)?.sender.track?.codec;
    return [
      ...(this.config.codecs[kind] ?? []),
      ...(trackCodec && trackCodec.mimeType.split("/")[0].toLowerCase() === kind
        ? [trackCodec]
        : []),
    ];
  }
}
