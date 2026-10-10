import { SCTP_STATE } from "../../../sctp/src";
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
  /**
   * Bumped when a first negotiation's provisional connection is retired: a
   * connect() still running for it no longer reports a connection state.
   */
  private connectEpoch = 0;

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
    this.connectEpoch++;
    const transports = [...this.secure.dtlsTransports];
    // A transport the rolled-back proposal connected, or only gave remote
    // credentials and candidates, is replaced: nothing of it stays live.
    if (
      transports.some(
        (dtls) =>
          dtls.state !== "new" ||
          !["new", "closed"].includes(dtls.iceTransport.state) ||
          !!dtls.iceTransport.getRemoteParameters(),
      )
    ) {
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
    }
    // Without a current session nothing is connected, whatever the
    // provisional connection had reported (the rolled-back proposal may also
    // have taken its transports with it): the public states start over.
    this.secure.updateIceConnectionState();
    this.secure.setConnectionState("new");
  }

  /** Activate a re-offer's staged transport parameters at its final answer. */
  async activatePendingRemote(pendingOnly = false) {
    const offer = this.sdp.pendingRemoteDescription;
    if (!offer || offer.type !== "offer") return;
    type Media = (typeof offer.media)[number];
    // A BUNDLE group shares one transport: the tag m-line carries its ICE /
    // DTLS parameters, and candidates or end-of-candidates trickled on any
    // member m-line belong to that transport's generation.
    type TransportEntry = {
      provisional: boolean;
      tag?: Media;
      candidates: Map<string, Media["iceCandidates"][number]>;
      eoc: boolean;
      members: Media[];
    };
    const byTransport = new Map<RTCIceTransport, TransportEntry>();
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
      const bundledNonTag = this.topology.isBundledNonTag(
        offer,
        media.rtp.muxId,
      );
      // A restart on a transport that keeps its SCTP association checks the
      // new generation beside the selected current pair.
      const provisional =
        pendingOnly &&
        !this.negotiation.isPendingOnlyTransport(dtls.iceTransport.id);
      if (media.kind === "application") {
        if (provisional) this.sctp.updateRemoteMaxMessageSize(media);
        else this.sctp.setRemoteSCTP(media, index);
      }
      const entry: TransportEntry = byTransport.get(dtls.iceTransport) ?? {
        provisional,
        candidates: new Map(),
        eoc: false,
        members: [],
      };
      byTransport.set(dtls.iceTransport, entry);
      entry.members.push(media);
      if (!bundledNonTag) {
        entry.tag = media;
        if (!provisional) {
          if (media.iceParams) {
            dtls.iceTransport.setRemoteParams(media.iceParams);
          }
          if (media.dtlsParams) dtls.setRemoteParams(media.dtlsParams);
        }
      }
      for (const candidate of media.iceCandidates) {
        entry.candidates.set(candidate.toJSON().candidate, candidate);
      }
      if (media.iceCandidatesComplete) entry.eoc = true;
    }
    for (const [transport, entry] of byTransport) {
      // A member's candidate of another ICE generation (its own ufrag) does
      // not belong to the tag's generation.
      const ufrag = entry.tag?.iceParams?.usernameFragment;
      for (const [key, candidate] of entry.candidates) {
        if (ufrag && candidate.ufrag && candidate.ufrag !== ufrag) {
          entry.candidates.delete(key);
        }
      }
      if (entry.provisional) {
        if (entry.tag) {
          await this.applyProvisionalIce(
            transport,
            entry.tag,
            [...entry.candidates.values()],
            entry.eoc,
          );
        }
        continue;
      }
      for (const candidate of entry.candidates.values()) {
        transport.deliverRemoteCandidate(candidate);
      }
      if (entry.eoc) transport.deliverRemoteCandidate(undefined);
    }
    // End-of-candidates completes the transport's generation, so every m-line
    // of the description it carries (a BUNDLE group) records it.
    for (const entry of byTransport.values()) {
      if (!entry.eoc) continue;
      for (const media of entry.members) media.iceCandidatesComplete = true;
    }
  }

  async applyProvisionalIce(
    iceTransport: RTCIceTransport,
    media: MediaDescription,
    candidates = media.iceCandidates,
    endOfCandidates = media.iceCandidatesComplete,
  ) {
    if (!iceTransport.hasStagedRestart || !media.iceParams) return;
    iceTransport.setProvisionalRemoteParams(media.iceParams);
    for (const candidate of candidates) {
      iceTransport.deliverProvisionalRemoteCandidate(candidate);
    }
    if (endOfCandidates) {
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
    const epoch = this.connectEpoch;

    const res = await Promise.allSettled(
      this.secure.dtlsTransports.map(async (dtlsTransport) => {
        const { iceTransport } = dtlsTransport;
        let progressed = false;
        let iceReady = ["connected", "completed"].includes(iceTransport.state);

        // Only a transport an applied description gave remote parameters
        // starts; one whose parameters arrive with a later description (a
        // renegotiation pranswer stages them for the final answer) waits.
        if (
          !iceTransport.checksStarted &&
          !iceTransport.getRemoteParameters()
        ) {
          return progressed;
        }
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
          const state = await settledState(
            dtlsTransport.onStateChange,
            () => dtlsTransport.state,
            (state) => state !== "connecting",
          );
          if (state !== "connected") {
            throw new Error(`DTLS transport ${state}`);
          }
          this.startJoinedSctp(dtlsTransport);
          return true;
        }
        if (dtlsTransport.state === "connected") {
          this.startJoinedSctp(dtlsTransport);
        }
        if (
          dtlsTransport.state !== "new" ||
          !iceReady ||
          !dtlsTransport.hasRemoteParameters
        ) {
          return progressed;
        }

        this.secure.setConnectionState("connecting");
        await dtlsTransport.start().catch((err) => {
          log("dtlsTransport.start failed", err);
          throw err;
        });

        if (
          this.sctp.sctpTransport &&
          this.sctp.sctpTransport.dtlsTransport.id === dtlsTransport.id
        ) {
          await this.sctp.connectSctp();
        }
        return true;
      }),
    );

    if (epoch !== this.connectEpoch) return;
    if (res.find((r) => r.status === "rejected")) {
      this.secure.setConnectionState("failed");
    } else if (res.some((r) => r.status === "fulfilled" && r.value)) {
      this.secure.setConnectionState("connected");
    }
  }

  /**
   * An SCTP transport that joined an already connected DTLS transport (the
   * first application m-line of a renegotiation) starts its association
   * there; the DTLS start above only covers a new transport.
   */
  private startJoinedSctp(dtlsTransport: RTCDtlsTransport) {
    const sctp = this.sctp.sctpTransport;
    if (
      !sctp ||
      sctp.dtlsTransport !== dtlsTransport ||
      sctp.sctp.started ||
      sctp.sctp.associationState !== SCTP_STATE.CLOSED
    ) {
      return;
    }
    this.sctp.connectSctp().catch((error) => {
      log("sctp start failed", error);
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
