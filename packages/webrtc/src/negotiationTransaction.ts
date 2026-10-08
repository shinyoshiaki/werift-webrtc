import type { RTCRtpTransceiver, RtpRouter, TransceiverManager } from "./media";
import type {
  RouterSnapshot,
  TransceiverNegotiationState,
  TransceiversNegotiationState,
} from "./negotiation/internalState";
import type { SctpNegotiationState, SctpTransportManager } from "./sctpManager";
import type { SessionDescription } from "./sdp";
import type { SDPManager } from "./sdpManager";
import type { RTCDtlsTransport } from "./transport/dtls";

/**
 * The reversible state of a negotiation. Each component captures and restores
 * its own part, so a new piece of state is added where it lives (its
 * `snapshot*` / `restore*` pair), not here.
 */
type Baseline = {
  transceivers: TransceiversNegotiationState;
  routes: RouterSnapshot;
  sctp: SctpNegotiationState;
};

/**
 * Resources a pending proposal created or prepared. They belong to the
 * proposal: replacement and rollback drop them, a checkpoint copies them.
 */
class ProposalResources {
  /** Transceivers a remote offer created. */
  readonly remoteCreated = new Set<RTCRtpTransceiver>();
  /** Transceivers whose m-line a remote offer recycled with a new MID. */
  readonly displaced = new Set<RTCRtpTransceiver>();
  /** Transport each MID uses under the proposal (BUNDLE topology). */
  readonly prepared = new Map<string, RTCDtlsTransport>();
  /** Prepared transports no live binding uses yet. */
  readonly pendingOnly = new Set<RTCDtlsTransport>();
  /** Transports a remote offer created to own a BUNDLE group or an m-line. */
  readonly owners = new Set<RTCDtlsTransport>();
  /** Pending-only transports whose candidates were already emitted. */
  readonly emittedCandidates = new Set<string>();
  /** The description the transports were prepared for. */
  preparedFor?: SessionDescription;

  /** Transports that only this proposal holds. */
  get speculativeTransports() {
    return [...this.pendingOnly, ...this.owners];
  }

  clear() {
    this.assign(new ProposalResources());
  }

  copy() {
    const copy = new ProposalResources();
    copy.assign(this);
    return copy;
  }

  assign(source: ProposalResources) {
    replaceSet(this.remoteCreated, source.remoteCreated);
    replaceSet(this.displaced, source.displaced);
    replaceSet(this.pendingOnly, source.pendingOnly);
    replaceSet(this.owners, source.owners);
    replaceSet(this.emittedCandidates, source.emittedCandidates);
    this.prepared.clear();
    for (const [mid, transport] of source.prepared) {
      this.prepared.set(mid, transport);
    }
    this.preparedFor = source.preparedFor;
  }
}

export type NegotiationCheckpoint = {
  state: Baseline;
  resources: ProposalResources;
};

function replaceSet<T>(target: Set<T>, source: Iterable<T>) {
  const values = [...source];
  target.clear();
  for (const value of values) target.add(value);
}

/** Remote ufrags of retired generations kept to reject late callbacks. */
const RETIRED_UFRAG_HISTORY = 64;

/** One owner for the reversible metadata of a PeerConnection negotiation. */
export class NegotiationTransaction {
  private baseline?: Baseline;
  private offerSnapshot?: Baseline;
  private readonly resources = new ProposalResources();
  private readonly retiredRemoteUfrags = new Set<string>();
  /**
   * Transports created since the last commit. One that no binding holds at
   * commit (e.g. a data channel's own transport that BUNDLE replaced) stops.
   */
  private readonly createdTransports = new Set<RTCDtlsTransport>();
  /** Negotiation state of each transceiver a remote offer created, at creation. */
  private readonly createdStates = new WeakMap<
    RTCRtpTransceiver,
    TransceiverNegotiationState
  >();
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

  // # lifecycle

  /**
   * `createOffer` in stable records the baseline it would roll back to, but
   * does not open a transaction: nothing is pending until the offer is set.
   */
  snapshotForOffer() {
    if (this.baseline) return;
    const fresh = this.capture();
    if (!this.offerSnapshot) {
      this.offerSnapshot = fresh;
      return;
    }
    // Earlier createOffer calls were not applied: keep the state from before
    // the first of them (their MIDs and m-line indexes are not negotiated),
    // and only add transceivers the application created since.
    const { order, states } = this.offerSnapshot.transceivers;
    for (const [transceiver, state] of fresh.transceivers.states) {
      if (!states.has(transceiver)) {
        states.set(transceiver, state);
        order.push(transceiver);
      }
    }
  }

  /**
   * Open the transaction when a description is applied. A local offer uses
   * the snapshot taken by the `createOffer` that produced it, so MIDs that
   * createOffer assigned revert on rollback; anything else captures now.
   */
  begin({ fromCreatedOffer = false }: { fromCreatedOffer?: boolean } = {}) {
    if (!this.baseline && !fromCreatedOffer && this.offerSnapshot) {
      // When a remote offer opens the transaction instead, what an unapplied
      // createOffer associated goes back first.
      this.transceivers.revertUnappliedAssociations(
        this.offerSnapshot.transceivers,
      );
      this.sctp.revertUnappliedAssociation(this.offerSnapshot.sctp);
    }
    if (!this.baseline) {
      this.baseline =
        (fromCreatedOffer ? this.offerSnapshot : undefined) ?? this.capture();
    }
    this.offerSnapshot = undefined;
    this.revision++;
    this.phase = "pending";
    return this.revision;
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

  async commit() {
    this.phase = "committing";
    // Routes and decode entries a pending proposal could not take from the
    // current session switch now, together with the descriptions.
    this.router.commitStaged();
    for (const transceiver of this.transceivers.getTransceivers()) {
      transceiver.receiver.commitStagedReceive();
    }
    // The recycling offer is final: the displaced transceiver stops for good.
    for (const transceiver of this.resources.displaced) {
      if (!transceiver.stopped) continue;
      transceiver.setCurrentDirection("stopped");
      transceiver.receiver.stop();
      transceiver.sender.stop();
    }
    // Every transport the previous session or this transaction used is a
    // candidate; those no live binding holds after the commit stop.
    const candidates = new Set(this.createdTransports);
    for (const { transceiver } of this.baseline?.transceivers.states.values() ??
      []) {
      candidates.add(transceiver.dtlsTransport);
    }
    if (this.baseline?.sctp.dtlsTransport) {
      candidates.add(this.baseline.sctp.dtlsTransport);
    }
    this.createdTransports.clear();
    this.cleanup();
    const inUse = this.transportsInUse({ includeStopped: false });
    await Promise.all(
      [...candidates]
        .filter((transport) => !inUse.has(transport))
        .map((transport) => transport.stop()),
    );
  }

  /** A replacement proposal: back to the baseline, which stays for the new one. */
  async replace() {
    if (!this.baseline) return;
    await this.restoreState(
      this.baseline,
      this.resources.remoteCreated,
      this.resources.speculativeTransports,
    );
    this.resources.clear();
    this.revision++;
    this.phase = "pending";
  }

  async rollback() {
    if (!this.baseline) return;
    await this.restoreState(
      this.baseline,
      this.resources.remoteCreated,
      this.resources.speculativeTransports,
    );
    this.cleanup();
  }

  /**
   * Record the state before one description operation mutates anything, so a
   * failure inside that operation can undo exactly its own changes.
   */
  checkpoint(): NegotiationCheckpoint {
    return { state: this.capture(), resources: this.resources.copy() };
  }

  /** Undo one failed description operation back to its checkpoint. */
  async restoreCheckpoint(checkpoint: NegotiationCheckpoint) {
    const before = checkpoint.resources;
    const kept = new Set(before.speculativeTransports);
    await this.restoreState(
      checkpoint.state,
      [...this.resources.remoteCreated].filter(
        (transceiver) => !before.remoteCreated.has(transceiver),
      ),
      this.resources.speculativeTransports.filter(
        (transport) => !kept.has(transport),
      ),
    );
    this.resources.assign(before);
    this.phase = "pending";
  }

  /**
   * PeerConnection close: stop every transport only the negotiation holds
   * (created for a proposal, pending-only, BUNDLE owners, prepared for a
   * topology), which no transceiver or SCTP binding would stop, then drop
   * every reference.
   */
  async dispose() {
    const transports = new Set([
      ...this.createdTransports,
      ...this.resources.speculativeTransports,
      ...this.resources.prepared.values(),
    ]);
    this.createdTransports.clear();
    this.offerSnapshot = undefined;
    this.cleanup();
    await Promise.allSettled(
      [...transports].map((transport) => transport.stop()),
    );
  }

  // # proposal resources

  noteCreatedTransport(transport: RTCDtlsTransport) {
    this.createdTransports.add(transport);
    // A stopped transport needs no cleanup; do not keep referencing it.
    transport.onStateChange.subscribe((state) => {
      if (state === "closed") this.createdTransports.delete(transport);
    });
  }

  rememberRemoteTransceiver(transceiver: RTCRtpTransceiver) {
    this.resources.remoteCreated.add(transceiver);
    // Before the offer negotiates anything on it: a rollback that keeps the
    // transceiver (the application uses it) returns it to this state.
    this.createdStates.set(transceiver, transceiver.snapshotNegotiationState());
  }

  rememberOwnerTransport(transport: RTCDtlsTransport) {
    this.resources.owners.add(transport);
  }

  rememberDisplacedTransceiver(transceiver: RTCRtpTransceiver) {
    this.resources.displaced.add(transceiver);
  }

  get preparedDescription() {
    return this.resources.preparedFor;
  }

  get transportByMid() {
    return this.resources.prepared;
  }

  isPendingOnlyTransport(iceTransportId: string) {
    return [...this.resources.pendingOnly].some(
      (transport) => transport.iceTransport.id === iceTransportId,
    );
  }

  takePreparedCandidateTransports() {
    const { pendingOnly, emittedCandidates } = this.resources;
    const transports = [...pendingOnly].filter(
      (transport) => !emittedCandidates.has(transport.id),
    );
    for (const transport of transports) {
      emittedCandidates.add(transport.id);
    }
    return transports;
  }

  prepareTransport(
    description: SessionDescription,
    mid: string,
    transport: RTCDtlsTransport,
    pendingOnly = false,
  ) {
    this.resources.preparedFor = description;
    this.resources.prepared.set(mid, transport);
    if (pendingOnly) this.resources.pendingOnly.add(transport);
  }

  async discardPreparedTransports() {
    const { prepared, pendingOnly, emittedCandidates } = this.resources;
    const stopping = [...pendingOnly];
    prepared.clear();
    pendingOnly.clear();
    emittedCandidates.clear();
    this.resources.preparedFor = undefined;
    await Promise.allSettled(stopping.map((transport) => transport.stop()));
  }

  /**
   * A remote pranswer or answer replaces every earlier remote pranswer of
   * this offer: routes and receive values those staged are dropped before it
   * applies, so the commit switches only to what the latest description
   * carries.
   */
  discardStagedRemoteAnswer() {
    this.router.restoreStaged({ ssrc: [], rid: [] });
    for (const transceiver of this.transceivers.getTransceivers()) {
      transceiver.receiver.discardStagedReceive();
    }
  }

  // # retired ICE generations

  retireRemoteGeneration(description?: SessionDescription) {
    for (const media of description?.media ?? []) {
      const ufrag = media.iceParams?.usernameFragment;
      if (ufrag) this.retiredRemoteUfrags.add(ufrag);
    }
    // A bounded history covers late callbacks without retaining every past
    // negotiation for the lifetime of a long-running peer.
    while (this.retiredRemoteUfrags.size > RETIRED_UFRAG_HISTORY) {
      this.retiredRemoteUfrags.delete(
        this.retiredRemoteUfrags.values().next().value!,
      );
    }
  }

  isRetiredRemoteUfrag(ufrag?: string | null) {
    return !!ufrag && this.retiredRemoteUfrags.has(ufrag);
  }

  // # state capture and restore

  private capture(): Baseline {
    return {
      transceivers: this.transceivers.snapshotNegotiationState(),
      routes: this.router.snapshotRoutes(),
      sctp: this.sctp.snapshotNegotiationState(),
    };
  }

  /**
   * Put transceivers, routes and SCTP back to `baseline`. Transceivers in
   * `added` and transports in `speculative` were created after it; those no
   * restored owner uses stop.
   */
  private async restoreState(
    baseline: Baseline,
    added: Iterable<RTCRtpTransceiver>,
    speculative: Iterable<RTCDtlsTransport>,
  ) {
    const removedTransports = this.transceivers.restoreNegotiationState(
      baseline.transceivers,
      added,
      (transceiver) => this.createdStates.get(transceiver),
    );
    const live = this.transceivers.getTransceivers();
    this.router.restoreRoutes(baseline.routes, {
      endpoints: new Set(live.flatMap((t) => [t.sender, t.receiver])),
      liveSenders: live
        .filter((t) => !t.stopped && !t.stopping)
        .map((t) => t.sender),
    });
    await this.sctp.restoreNegotiationState(baseline.sctp);

    const inUse = this.transportsInUse({ includeStopped: true });
    for (const transport of new Set([...speculative, ...removedTransports])) {
      if (!inUse.has(transport)) await transport.stop();
    }
  }

  /** Transports a transceiver (optionally a stopped one) or SCTP is bound to. */
  private transportsInUse({ includeStopped }: { includeStopped: boolean }) {
    const inUse = new Set(
      this.transceivers
        .getTransceivers()
        .filter((transceiver) => includeStopped || !transceiver.stopped)
        .map((transceiver) => transceiver.dtlsTransport),
    );
    const sctp = this.sctp.sctpTransport?.dtlsTransport;
    if (sctp) inUse.add(sctp);
    return inUse;
  }

  private cleanup() {
    this.baseline = undefined;
    this.resources.clear();
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
      baselineTransceivers: this.baseline?.transceivers.states.size ?? 0,
      remoteCreated: this.resources.remoteCreated.size,
      pendingTransports: this.resources.pendingOnly.size,
      createdTransports: [...this.createdTransports],
      hasOfferSnapshot: !!this.offerSnapshot,
    };
  }
}
