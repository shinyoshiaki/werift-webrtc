import { type Event, debug } from "../imports/common";
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
   * Start ICE, DTLS and SCTP on every live transport that still needs it.
   *
   * ICE checks start only for a generation that has not run them (the first
   * negotiation or a committed restart); checks already running are
   * awaited, and an established, completed or failed generation is left to
   * its own state machine (consent freshness, a later ICE restart). A DTLS
   * handshake already running is awaited rather than started again. The
   * connection state changes only when this call started or awaited work.
   */
  async connect() {
    log("start connect");

    const res = await Promise.allSettled(
      this.secure.dtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        let progressed = false;
        let iceReady = ["connected", "completed"].includes(iceTransport.state);

        if (!iceTransport.checksStarted) {
          progressed = true;
          this.secure.setConnectionState("connecting");
          await iceTransport.start().catch((err) => {
            log("iceTransport.start failed", err);
            throw err;
          });
          iceReady = true;
        } else if (iceTransport.state === "checking") {
          // Checks an earlier connect() (or a pranswer) started are awaited,
          // never started again.
          progressed = true;
          await iceTransport.checksSettled();
          iceReady = ["connected", "completed"].includes(iceTransport.state);
          if (!iceReady) {
            throw new Error(`ICE transport ${iceTransport.state}`);
          }
        }

        if (dtlsTransport.state === "connecting") {
          progressed = true;
          const state = await settledState(
            dtlsTransport.onStateChange,
            () => dtlsTransport.state,
            (state) => state !== "connecting",
          );
          if (state !== "connected") {
            throw new Error(`DTLS transport ${state}`);
          }
        } else if (dtlsTransport.state === "new" && iceReady) {
          progressed = true;
          this.secure.setConnectionState("connecting");
          await dtlsTransport.start().catch((err) => {
            log("dtlsTransport.start failed", err);
            throw err;
          });
        }
        if (dtlsTransport.state !== "connected") {
          return progressed;
        }

        // SCTP is ensured on its own: an association a renegotiation added
        // on an already connected DTLS transport starts here too, without
        // touching ICE / DTLS or the connection state.
        if (
          this.sctp.sctpTransport &&
          this.sctp.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctp.connectSctp();
        }
        return progressed;
      }),
    );

    if (res.find((r) => r.status === "rejected")) {
      this.secure.setConnectionState("failed");
    } else if (res.some((r) => r.status === "fulfilled" && r.value)) {
      this.secure.setConnectionState("connected");
    }
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

/**
 * The first state `done` accepts: the current one, or a later one `event`
 * reports. A completed event (the transport stopped) settles with the state
 * the transport is left in.
 */
function settledState<S>(
  event: Event<[S]>,
  current: () => S,
  done: (state: S) => boolean,
) {
  return new Promise<S>((resolve) => {
    if (done(current()) || event.ended) {
      resolve(current());
      return;
    }
    const { unSubscribe } = event.subscribe(
      (state) => {
        if (!done(state)) return;
        unSubscribe();
        resolve(state);
      },
      () => resolve(current()),
    );
  });
}
