import { SCTP_STATE } from "../../sctp/src";
import type { RTCRtpTransceiver, RtpRouter, TransceiverManager } from "./media";
import { getApplicationStopRevision } from "./media/rtpTransceiver";
import type { SctpTransportManager } from "./sctpManager";
import type { SessionDescription } from "./sdp";
import type { SDPManager } from "./sdpManager";
import type { RTCDtlsTransport } from "./transport/dtls";

type TransceiverBaseline = {
  mid: string | null;
  mLineIndex?: number;
  codecs: RTCRtpTransceiver["codecs"];
  headerExtensions: RTCRtpTransceiver["headerExtensions"];
  offerDirection: RTCRtpTransceiver["offerDirection"];
  currentDirection: RTCRtpTransceiver["currentDirection"];
  stopping: boolean;
  stopped: boolean;
  applicationStopRevision: number;
  dtlsTransport: RTCDtlsTransport;
  senderCodec: RTCRtpTransceiver["sender"]["codec"];
  remoteStreamIds: string[];
  remoteStreamId?: string;
  remoteTrackId?: string;
  receiverTracks: RTCRtpTransceiver["receiver"]["tracks"];
  receiverBySsrc: RTCRtpTransceiver["receiver"]["trackBySSRC"];
  receiverByRid: RTCRtpTransceiver["receiver"]["trackByRID"];
  receiveTables: ReturnType<
    RTCRtpTransceiver["receiver"]["snapshotReceiveTables"]
  >;
  notifiedRemoteTrack: ReturnType<TransceiverManager["getNotifiedRemoteTrack"]>;
};

type Baseline = {
  orderedTransceivers: RTCRtpTransceiver[];
  transceivers: Map<RTCRtpTransceiver, TransceiverBaseline>;
  ssrcTable: RtpRouter["ssrcTable"];
  ridTable: RtpRouter["ridTable"];
  extIdUriMap: RtpRouter["extIdUriMap"];
  sctpTransport: SctpTransportManager["sctpTransport"];
  sctpDtlsTransport?: RTCDtlsTransport;
  sctpRemotePort?: number;
  sctpMid?: string;
  sctpMLineIndex?: number;
  sctpRemoteMaxMessageSize?: number;
};

export type NegotiationCheckpoint = {
  state: Baseline;
  remoteCreated: Set<RTCRtpTransceiver>;
  displaced: Set<RTCRtpTransceiver>;
  pendingOnly: Set<RTCDtlsTransport>;
  prepared: Map<string, RTCDtlsTransport>;
  emitted: Set<string>;
  preparedFor?: SessionDescription;
};

function replaceSet<T>(target: Set<T>, source: Set<T>) {
  target.clear();
  for (const value of source) target.add(value);
}

/** One owner for the reversible metadata of a PeerConnection negotiation. */
export class NegotiationTransaction {
  private baseline?: Baseline;
  private offerSnapshot?: Baseline;
  private readonly remoteCreated = new Set<RTCRtpTransceiver>();
  /** Transceivers whose m-line a remote offer recycled with a new MID. */
  private readonly displaced = new Set<RTCRtpTransceiver>();
  private readonly preparedTransports = new Map<string, RTCDtlsTransport>();
  private readonly pendingOnlyTransports = new Set<RTCDtlsTransport>();
  private readonly emittedPendingCandidates = new Set<string>();
  private preparedFor?: SessionDescription;
  private readonly retiredRemoteUfrags = new Set<string>();
  /**
   * Transports created since the last commit. One that no binding holds at
   * commit (e.g. a data channel's own transport that BUNDLE replaced) stops.
   */
  private readonly createdTransports = new Set<RTCDtlsTransport>();
  private revision = 0;
  private phase:
    | "idle"
    | "pending"
    | "validating"
    | "preparing"
    | "committing" = "idle";

  constructor(
    private readonly sdp: SDPManager,
    private readonly transceivers: TransceiverManager,
    private readonly router: RtpRouter,
    private readonly sctp: SctpTransportManager,
  ) {}

  /**
   * `createOffer` in stable records the baseline it would roll back to, but
   * does not open a transaction: nothing is pending until the offer is set.
   */
  snapshotForOffer() {
    if (!this.baseline) this.offerSnapshot = this.capture();
  }

  /**
   * Open the transaction when a description is applied. A local offer uses
   * the snapshot taken by the `createOffer` that produced it, so MIDs that
   * createOffer assigned revert on rollback; anything else captures now.
   */
  begin({ fromCreatedOffer = false }: { fromCreatedOffer?: boolean } = {}) {
    if (!this.baseline) {
      this.baseline =
        (fromCreatedOffer ? this.offerSnapshot : undefined) ?? this.capture();
    }
    this.offerSnapshot = undefined;
    this.revision++;
    this.phase = "pending";
    return this.revision;
  }

  private capture(): Baseline {
    return {
      orderedTransceivers: [...this.transceivers.getTransceivers()],
      transceivers: new Map(
        this.transceivers.getTransceivers().map((transceiver) => [
          transceiver,
          {
            mid: transceiver.mid,
            mLineIndex: transceiver.mLineIndex,
            codecs: transceiver.codecs,
            headerExtensions: transceiver.headerExtensions,
            offerDirection: transceiver.offerDirection,
            currentDirection: transceiver.currentDirection,
            stopping: transceiver.stopping,
            stopped: transceiver.stopped,
            applicationStopRevision: getApplicationStopRevision(transceiver),
            dtlsTransport: transceiver.dtlsTransport,
            senderCodec: transceiver.sender.codec,
            remoteStreamIds: [...transceiver.receiver.remoteStreamIds],
            remoteStreamId: transceiver.receiver.remoteStreamId,
            remoteTrackId: transceiver.receiver.remoteTrackId,
            receiverTracks: [...transceiver.receiver.tracks],
            receiverBySsrc: { ...transceiver.receiver.trackBySSRC },
            receiverByRid: { ...transceiver.receiver.trackByRID },
            receiveTables: transceiver.receiver.snapshotReceiveTables(),
            notifiedRemoteTrack:
              this.transceivers.getNotifiedRemoteTrack(transceiver),
          },
        ]),
      ),
      ssrcTable: { ...this.router.ssrcTable },
      ridTable: { ...this.router.ridTable },
      extIdUriMap: { ...this.router.extIdUriMap },
      sctpTransport: this.sctp.sctpTransport,
      sctpDtlsTransport: this.sctp.sctpTransport?.dtlsTransport,
      sctpRemotePort: this.sctp.sctpRemotePort,
      sctpMid: this.sctp.sctpTransport?.mid,
      sctpMLineIndex: this.sctp.sctpTransport?.mLineIndex,
      sctpRemoteMaxMessageSize: this.sctp.sctpTransport?.remoteMaxMessageSize,
    };
  }

  noteCreatedTransport(transport: RTCDtlsTransport) {
    this.createdTransports.add(transport);
    // A stopped transport needs no cleanup; do not keep referencing it.
    transport.onStateChange.subscribe((state) => {
      if (state === "closed") this.createdTransports.delete(transport);
    });
  }

  /** A description was applied without committing: the proposal is pending. */
  settle() {
    if (this.baseline) this.phase = "pending";
  }

  validate() {
    this.phase = "validating";
  }

  prepare() {
    this.phase = "preparing";
  }

  rememberRemoteTransceiver(transceiver: RTCRtpTransceiver) {
    this.remoteCreated.add(transceiver);
  }

  rememberDisplacedTransceiver(transceiver: RTCRtpTransceiver) {
    this.displaced.add(transceiver);
  }

  get preparedDescription() {
    return this.preparedFor;
  }

  get transportByMid() {
    return this.preparedTransports;
  }

  isPendingOnlyTransport(iceTransportId: string) {
    return [...this.pendingOnlyTransports].some(
      (transport) => transport.iceTransport.id === iceTransportId,
    );
  }

  takePreparedCandidateTransports() {
    const transports = [...this.pendingOnlyTransports].filter(
      (transport) => !this.emittedPendingCandidates.has(transport.id),
    );
    for (const transport of transports) {
      this.emittedPendingCandidates.add(transport.id);
    }
    return transports;
  }

  prepareTransport(
    description: SessionDescription,
    mid: string,
    transport: RTCDtlsTransport,
    pendingOnly = false,
  ) {
    this.preparedFor = description;
    this.preparedTransports.set(mid, transport);
    if (pendingOnly) this.pendingOnlyTransports.add(transport);
  }

  async discardPreparedTransports() {
    const pendingOnly = [...this.pendingOnlyTransports];
    this.preparedTransports.clear();
    this.pendingOnlyTransports.clear();
    this.emittedPendingCandidates.clear();
    this.preparedFor = undefined;
    await Promise.allSettled(pendingOnly.map((transport) => transport.stop()));
  }

  retireRemoteGeneration(description?: SessionDescription) {
    for (const media of description?.media ?? []) {
      const ufrag = media.iceParams?.usernameFragment;
      if (ufrag) this.retiredRemoteUfrags.add(ufrag);
    }
    // A bounded history covers late callbacks without retaining every past
    // negotiation for the lifetime of a long-running peer.
    while (this.retiredRemoteUfrags.size > 64) {
      this.retiredRemoteUfrags.delete(
        this.retiredRemoteUfrags.values().next().value!,
      );
    }
  }

  isRetiredRemoteUfrag(ufrag?: string | null) {
    return !!ufrag && this.retiredRemoteUfrags.has(ufrag);
  }

  async commit() {
    this.phase = "committing";
    // The recycling offer is final: the displaced transceiver stops for good.
    for (const transceiver of this.displaced) {
      if (!transceiver.stopped) continue;
      transceiver.setCurrentDirection("stopped");
      transceiver.receiver.stop();
      transceiver.sender.stop();
    }
    const oldTransports = new Set(
      [...(this.baseline?.transceivers.values() ?? [])].map(
        (state) => state.dtlsTransport,
      ),
    );
    if (this.baseline?.sctpDtlsTransport) {
      oldTransports.add(this.baseline.sctpDtlsTransport);
    }
    for (const transport of this.createdTransports) {
      oldTransports.add(transport);
    }
    this.createdTransports.clear();
    this.cleanup();
    const inUse = new Set(
      this.transceivers
        .getTransceivers()
        .filter((transceiver) => !transceiver.stopped)
        .map((transceiver) => transceiver.dtlsTransport),
    );
    if (this.sctp.sctpTransport?.dtlsTransport) {
      inUse.add(this.sctp.sctpTransport.dtlsTransport);
    }
    await Promise.all(
      [...oldTransports]
        .filter((transport) => !inUse.has(transport))
        .map((transport) => transport.stop()),
    );
  }

  async replace() {
    await this.restore(true);
  }

  async rollback() {
    await this.restore(false);
  }

  private async restore(keepBaseline: boolean) {
    const baseline = this.baseline;
    if (!baseline) return;

    await this.restoreState(
      baseline,
      this.remoteCreated,
      this.pendingOnlyTransports,
    );
    if (keepBaseline) {
      this.remoteCreated.clear();
      this.displaced.clear();
      this.preparedTransports.clear();
      this.pendingOnlyTransports.clear();
      this.emittedPendingCandidates.clear();
      this.preparedFor = undefined;
      this.revision++;
      this.phase = "pending";
    } else {
      this.cleanup();
    }
  }

  /**
   * Record the state before one description operation mutates anything, so a
   * failure inside that operation can undo exactly its own changes.
   */
  checkpoint(): NegotiationCheckpoint {
    return {
      state: this.capture(),
      remoteCreated: new Set(this.remoteCreated),
      displaced: new Set(this.displaced),
      pendingOnly: new Set(this.pendingOnlyTransports),
      prepared: new Map(this.preparedTransports),
      emitted: new Set(this.emittedPendingCandidates),
      preparedFor: this.preparedFor,
    };
  }

  /** Undo one failed description operation back to its checkpoint. */
  async restoreCheckpoint(checkpoint: NegotiationCheckpoint) {
    await this.restoreState(
      checkpoint.state,
      new Set(
        [...this.remoteCreated].filter(
          (transceiver) => !checkpoint.remoteCreated.has(transceiver),
        ),
      ),
      new Set(
        [...this.pendingOnlyTransports].filter(
          (transport) => !checkpoint.pendingOnly.has(transport),
        ),
      ),
    );
    replaceSet(this.remoteCreated, checkpoint.remoteCreated);
    replaceSet(this.displaced, checkpoint.displaced);
    replaceSet(this.pendingOnlyTransports, checkpoint.pendingOnly);
    replaceSet(this.emittedPendingCandidates, checkpoint.emitted);
    this.preparedTransports.clear();
    for (const [mid, transport] of checkpoint.prepared) {
      this.preparedTransports.set(mid, transport);
    }
    this.preparedFor = checkpoint.preparedFor;
    this.phase = "pending";
  }

  /**
   * Put transceivers, routes and SCTP back to `baseline`. Transceivers in
   * `removable` and transports in `orphanCandidates` were added after it.
   */
  private async restoreState(
    baseline: Baseline,
    removable: Set<RTCRtpTransceiver>,
    orphanCandidates: Set<RTCDtlsTransport>,
  ) {
    for (const [transceiver, state] of baseline.transceivers) {
      transceiver.mid = state.mid;
      transceiver.mLineIndex = state.mLineIndex;
      transceiver.codecs = state.codecs;
      transceiver.headerExtensions = state.headerExtensions;
      transceiver.offerDirection = state.offerDirection;
      transceiver.setCurrentDirection(state.currentDirection ?? undefined);
      transceiver.stopping =
        state.stopping ||
        getApplicationStopRevision(transceiver) !==
          state.applicationStopRevision;
      transceiver.stopped = state.stopped;
      transceiver.setDtlsTransport(state.dtlsTransport);
      transceiver.sender.codec = state.senderCodec;
      transceiver.receiver.remoteStreamIds = state.remoteStreamIds;
      transceiver.receiver.remoteStreamId = state.remoteStreamId;
      transceiver.receiver.remoteTrackId = state.remoteTrackId;
      transceiver.receiver.tracks.splice(
        0,
        transceiver.receiver.tracks.length,
        ...state.receiverTracks,
      );
      // SSRCs learned from RID packets are live state, not SDP: keep those
      // whose track survives the rollback.
      const learnedTracks = Object.entries(
        transceiver.receiver.trackBySSRC,
      ).filter(
        ([ssrc, track]) =>
          transceiver.receiver.learnedTrackSsrcs.has(Number(ssrc)) &&
          !(ssrc in state.receiverBySsrc) &&
          state.receiverTracks.includes(track),
      );
      for (const ssrc of Object.keys(transceiver.receiver.trackBySSRC)) {
        delete transceiver.receiver.trackBySSRC[ssrc];
      }
      Object.assign(transceiver.receiver.trackBySSRC, state.receiverBySsrc);
      for (const [ssrc, track] of learnedTracks) {
        transceiver.receiver.trackBySSRC[ssrc] = track;
      }
      for (const rid of Object.keys(transceiver.receiver.trackByRID)) {
        delete transceiver.receiver.trackByRID[rid];
      }
      Object.assign(transceiver.receiver.trackByRID, state.receiverByRid);
      this.transceivers.restoreNotifiedRemoteTrack(
        transceiver,
        state.notifiedRemoteTrack,
      );
      // Codec/RTX tables added or changed by a pending description are
      // dropped; current RTP is decoded exactly as before the transaction.
      transceiver.receiver.restoreReceiveTables(state.receiveTables);
    }

    const orphanTransports = new Set<RTCDtlsTransport>(orphanCandidates);
    for (const transceiver of removable) {
      if (
        transceiver.sender.track ||
        getApplicationStopRevision(transceiver) > 0
      ) {
        transceiver.mid = null;
        transceiver.mLineIndex = undefined;
        continue;
      }
      orphanTransports.add(transceiver.dtlsTransport);
      this.transceivers.removeRemoteTransceiver(transceiver);
    }
    this.transceivers.restoreTransceiverOrder(baseline.orderedTransceivers);
    // Packet-learned SSRC routes stay when their receiver is still attached.
    const endpoints = new Set<unknown>(
      this.transceivers
        .getTransceivers()
        .flatMap((transceiver) => [transceiver.sender, transceiver.receiver]),
    );
    const learnedRoutes = Object.entries(this.router.ssrcTable).filter(
      ([ssrc, endpoint]) =>
        this.router.learnedSsrcs.has(Number(ssrc)) &&
        !(ssrc in baseline.ssrcTable) &&
        endpoints.has(endpoint),
    );
    this.router.ssrcTable = { ...baseline.ssrcTable };
    for (const [ssrc, endpoint] of learnedRoutes) {
      this.router.ssrcTable[Number(ssrc)] = endpoint;
    }
    this.router.ridTable = { ...baseline.ridTable };
    this.router.extIdUriMap = { ...baseline.extIdUriMap };

    const added =
      this.sctp.sctpTransport !== baseline.sctpTransport
        ? this.sctp.sctpTransport
        : undefined;
    // createDataChannel is an application operation: its SCTP transport
    // survives rollback, unbound from the rolled-back m-line, so the next
    // offer carries m=application again. An association that already ran
    // under the pending description is description state and is torn down.
    const keepAdded =
      !!added &&
      this.sctp.isApplicationOwned(added) &&
      added.sctp.associationState === SCTP_STATE.CLOSED;
    if (added && !keepAdded) {
      await added.stop();
    }
    this.sctp.sctpTransport = keepAdded ? added : baseline.sctpTransport;
    if (
      baseline.sctpTransport &&
      baseline.sctpDtlsTransport &&
      baseline.sctpTransport.dtlsTransport !== baseline.sctpDtlsTransport
    ) {
      baseline.sctpTransport.setDtlsTransport(baseline.sctpDtlsTransport);
    }
    if (added && keepAdded) this.sctp.detachFromDescription(added);
    this.sctp.sctpRemotePort = baseline.sctpRemotePort;
    if (baseline.sctpTransport) {
      baseline.sctpTransport.mid = baseline.sctpMid;
      baseline.sctpTransport.mLineIndex = baseline.sctpMLineIndex;
      if (baseline.sctpRemoteMaxMessageSize !== undefined) {
        baseline.sctpTransport.remoteMaxMessageSize =
          baseline.sctpRemoteMaxMessageSize;
      }
    }

    const inUse = new Set(
      this.transceivers.getTransceivers().map((t) => t.dtlsTransport),
    );
    if (this.sctp.sctpTransport?.dtlsTransport) {
      inUse.add(this.sctp.sctpTransport.dtlsTransport);
    }
    for (const transport of orphanTransports) {
      if (!inUse.has(transport)) await transport.stop();
    }
  }

  /** PeerConnection close: drop every reference the transaction holds. */
  dispose() {
    this.createdTransports.clear();
    this.offerSnapshot = undefined;
    this.cleanup();
  }

  private cleanup() {
    this.baseline = undefined;
    this.remoteCreated.clear();
    this.displaced.clear();
    this.preparedTransports.clear();
    this.pendingOnlyTransports.clear();
    this.emittedPendingCandidates.clear();
    this.preparedFor = undefined;
    this.phase = "idle";
  }

  /** Internal test observation, never exposed on the public API. */
  inspect() {
    return {
      phase: this.phase,
      revision: this.revision,
      currentLocal: this.sdp.currentLocalDescription,
      currentRemote: this.sdp.currentRemoteDescription,
      pendingLocal: this.sdp.pendingLocalDescription,
      pendingRemote: this.sdp.pendingRemoteDescription,
      baselineTransceivers: this.baseline?.transceivers.size ?? 0,
      remoteCreated: this.remoteCreated.size,
      pendingTransports: this.pendingOnlyTransports.size,
      createdTransports: [...this.createdTransports],
      hasOfferSnapshot: !!this.offerSnapshot,
    };
  }
}
