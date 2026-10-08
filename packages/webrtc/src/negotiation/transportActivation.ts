import { debug } from "../imports/common";
import type { TransceiverManager } from "../media";
import type { NegotiationTransaction } from "../negotiationTransaction";
import type { SctpTransportManager } from "../sctpManager";
import type { MediaDescription } from "../sdp";
import type { SDPManager } from "../sdpManager";
import type { SecureTransportManager } from "../secureTransportManager";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { RTCIceTransport } from "../transport/ice";
import type { RTCSignalingState } from "../types/domain";
import type { BundleTopology } from "./bundleTopology";

const log = debug(
  "werift:packages/webrtc/src/negotiation/transportActivation.ts",
);

/**
 * Starting transports for a negotiation: connecting the live ICE / DTLS /
 * SCTP bindings, connecting a provisional (pranswer) generation beside them,
 * activating the transport parameters a re-offer staged once its answer
 * commits, and retiring a first negotiation's provisional connection.
 */
export class TransportActivation {
  constructor(
    private readonly sdp: SDPManager,
    private readonly secure: SecureTransportManager,
    private readonly transceivers: TransceiverManager,
    private readonly sctp: SctpTransportManager,
    private readonly negotiation: NegotiationTransaction,
    private readonly topology: BundleTopology,
    private readonly host: {
      signalingState: () => RTCSignalingState;
      /** The transport a transceiver starts on (BUNDLE policy aware). */
      createTransport: () => RTCDtlsTransport;
    },
  ) {}

  /** Retire a first negotiation's provisional connection without losing app objects. */
  async cleanupInitialProvisional() {
    if (this.sdp.currentLocalDescription || this.sdp.currentRemoteDescription) {
      return;
    }
    const transports = [...this.secure.dtlsTransports];
    if (
      !transports.some(
        (dtls) =>
          dtls.state !== "new" ||
          !["new", "closed"].includes(dtls.iceTransport.state),
      )
    ) {
      return;
    }
    if (this.sctp.sctpTransport) {
      await this.sctp.sctpTransport.stop();
      this.sctp.sctpRemotePort = undefined;
    }
    await Promise.all(transports.map((dtls) => dtls.stop()));
    for (const transceiver of this.transceivers.getTransceivers()) {
      transceiver.setDtlsTransport(this.host.createTransport());
    }
    if (this.sctp.sctpTransport) {
      this.sctp.sctpTransport.setDtlsTransport(this.host.createTransport());
    }
    this.secure.updateIceConnectionState();
  }

  /** Activate a re-offer's staged transport parameters at its final answer. */
  async activatePendingRemote(pendingOnly = false) {
    const offer = this.sdp.pendingRemoteDescription;
    if (!offer || offer.type !== "offer") return;
    const candidatesByTransport = new Map<
      RTCIceTransport,
      Map<string, (typeof offer.media)[number]["iceCandidates"][number]>
    >();
    const eoc = new Set<RTCIceTransport>();
    const transportOfMedia = new Map<
      (typeof offer.media)[number],
      RTCIceTransport
    >();
    for (const [index, media] of offer.media.entries()) {
      if (media.port === 0) continue;
      const dtls =
        (media.rtp.muxId &&
          this.negotiation.transportByMid.get(media.rtp.muxId)) ||
        (media.kind === "application"
          ? this.sctp.sctpTransport?.dtlsTransport
          : this.transceivers
              .getTransceivers()
              .find((t) => t.mid === media.rtp.muxId)?.dtlsTransport);
      if (!dtls) continue;
      transportOfMedia.set(media, dtls.iceTransport);
      const bundledNonTag = this.topology.isBundledNonTag(
        offer,
        media.rtp.muxId,
      );
      if (
        pendingOnly &&
        !this.negotiation.isPendingOnlyTransport(dtls.iceTransport.id)
      ) {
        // A restart on a transport that keeps its SCTP association checks the
        // new generation beside the selected current pair.
        if (!bundledNonTag) {
          await this.applyProvisionalIce(dtls.iceTransport, media);
        }
        continue;
      }
      if (media.kind === "application") {
        this.sctp.setRemoteSCTP(media, index);
      }
      if (bundledNonTag) continue;
      if (media.iceParams) dtls.iceTransport.setRemoteParams(media.iceParams);
      if (media.dtlsParams) dtls.setRemoteParams(media.dtlsParams);
      const candidates =
        candidatesByTransport.get(dtls.iceTransport) ?? new Map();
      for (const candidate of media.iceCandidates) {
        candidates.set(candidate.toJSON().candidate, candidate);
      }
      candidatesByTransport.set(dtls.iceTransport, candidates);
      if (media.iceCandidatesComplete) eoc.add(dtls.iceTransport);
    }
    for (const [transport, candidates] of candidatesByTransport) {
      for (const candidate of candidates.values()) {
        transport.deliverRemoteCandidate(candidate);
      }
      if (eoc.has(transport)) transport.deliverRemoteCandidate(undefined);
    }
    // End-of-candidates completes the transport's generation, so every m-line
    // of the description it carries (a BUNDLE group) records it.
    for (const [media, transport] of transportOfMedia) {
      if (eoc.has(transport)) media.iceCandidatesComplete = true;
    }
  }

  async applyProvisionalIce(
    iceTransport: RTCIceTransport,
    media: MediaDescription,
  ) {
    if (!iceTransport.hasStagedRestart || !media.iceParams) return;
    iceTransport.setProvisionalRemoteParams(media.iceParams);
    for (const candidate of media.iceCandidates) {
      iceTransport.deliverProvisionalRemoteCandidate(candidate);
    }
    if (media.iceCandidatesComplete) {
      iceTransport.deliverProvisionalRemoteCandidate(undefined);
    }
  }

  /**
   * Start ICE, DTLS and SCTP on every live transport. Each layer is ensured
   * on its own, so an SCTP association a renegotiation added on an already
   * connected DTLS transport starts too, without touching ICE / DTLS.
   */
  async connect() {
    log("start connect");

    const res = await Promise.allSettled(
      this.secure.dtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        // A connected transport (e.g. one a renegotiation adds SCTP to) is
        // not touched: no ICE start and no "connecting" connection state.
        // Otherwise ICE is started as before, also when remote checks made
        // it usable first, because start() sets up the local connection.
        const linkConnected =
          ["connected", "completed"].includes(iceTransport.state) &&
          dtlsTransport.state === "connected";
        if (!linkConnected) {
          this.secure.setConnectionState("connecting");

          await iceTransport.start().catch((err) => {
            log("iceTransport.start failed", err);
            throw err;
          });

          await this.ensureDtlsConnected(dtlsTransport);
        }

        if (
          this.sctp.sctpTransport &&
          this.sctp.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctp.connectSctp();
        }
      }),
    );

    if (res.find((r) => r.status === "rejected")) {
      this.secure.setConnectionState("failed");
    } else {
      this.secure.setConnectionState("connected");
    }
  }

  /** Start DTLS once; a handshake already running is awaited, not restarted. */
  private async ensureDtlsConnected(dtlsTransport: RTCDtlsTransport) {
    if (dtlsTransport.state === "connected") return;
    if (dtlsTransport.state === "connecting") {
      await new Promise<void>((resolve, reject) => {
        const { unSubscribe } = dtlsTransport.onStateChange.subscribe(
          (state) => {
            if (state === "connecting") return;
            unSubscribe();
            if (state === "connected") resolve();
            else reject(new Error(`dtlsTransport ${state}`));
          },
        );
      });
      return;
    }
    await dtlsTransport.start().catch((err) => {
      log("dtlsTransport.start failed", err);
      throw err;
    });
  }

  /** Connect a provisional ICE/DTLS generation without changing live bindings. */
  async connectPending() {
    const pending = [
      ...new Set(this.negotiation.transportByMid.values()),
    ].filter((transport) =>
      this.negotiation.isPendingOnlyTransport(transport.iceTransport.id),
    );
    for (const iceTransport of this.secure.iceTransports) {
      if (!this.negotiation.isPendingOnlyTransport(iceTransport.id)) {
        iceTransport.startProvisionalChecks();
      }
    }
    await Promise.all(
      pending.map(async (transport) => {
        transport.iceTransport.connection.iceControlling =
          this.host.signalingState() === "have-remote-pranswer";
        await transport.iceTransport.start();
        if (transport.state !== "connected") await transport.start();
      }),
    );
  }
}
