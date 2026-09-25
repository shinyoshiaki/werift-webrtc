import type { RTCRtpTransceiver, RtpRouter, TransceiverManager } from "./media";
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
  dtlsTransport: RTCDtlsTransport;
  senderCodec: RTCRtpTransceiver["sender"]["codec"];
  remoteStreamIds: string[];
  remoteStreamId?: string;
  remoteTrackId?: string;
  receiverTracks: RTCRtpTransceiver["receiver"]["tracks"];
  receiverBySsrc: RTCRtpTransceiver["receiver"]["trackBySSRC"];
  receiverByRid: RTCRtpTransceiver["receiver"]["trackByRID"];
  notifiedRemoteTrack: ReturnType<TransceiverManager["getNotifiedRemoteTrack"]>;
};

/** One owner for the reversible metadata of a PeerConnection negotiation. */
export class NegotiationTransaction {
  private baseline?: {
    orderedTransceivers: RTCRtpTransceiver[];
    transceivers: Map<RTCRtpTransceiver, TransceiverBaseline>;
    ssrcTable: RtpRouter["ssrcTable"];
    ridTable: RtpRouter["ridTable"];
    extIdUriMap: RtpRouter["extIdUriMap"];
    sctpTransport: SctpTransportManager["sctpTransport"];
    sctpRemotePort?: number;
    sctpMid?: string;
    sctpMLineIndex?: number;
    sctpRemoteMaxMessageSize?: number;
  };
  private readonly remoteCreated = new Set<RTCRtpTransceiver>();
  private readonly preparedTransports = new Map<string, RTCDtlsTransport>();
  private readonly pendingOnlyTransports = new Set<RTCDtlsTransport>();
  private readonly emittedPendingCandidates = new Set<string>();
  private preparedFor?: SessionDescription;
  private readonly retiredRemoteUfrags = new Set<string>();
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

  begin() {
    if (!this.baseline) {
      this.baseline = {
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
              dtlsTransport: transceiver.dtlsTransport,
              senderCodec: transceiver.sender.codec,
              remoteStreamIds: [...transceiver.receiver.remoteStreamIds],
              remoteStreamId: transceiver.receiver.remoteStreamId,
              remoteTrackId: transceiver.receiver.remoteTrackId,
              receiverTracks: [...transceiver.receiver.tracks],
              receiverBySsrc: { ...transceiver.receiver.trackBySSRC },
              receiverByRid: { ...transceiver.receiver.trackByRID },
              notifiedRemoteTrack:
                this.transceivers.getNotifiedRemoteTrack(transceiver),
            },
          ]),
        ),
        ssrcTable: { ...this.router.ssrcTable },
        ridTable: { ...this.router.ridTable },
        extIdUriMap: { ...this.router.extIdUriMap },
        sctpTransport: this.sctp.sctpTransport,
        sctpRemotePort: this.sctp.sctpRemotePort,
        sctpMid: this.sctp.sctpTransport?.mid,
        sctpMLineIndex: this.sctp.sctpTransport?.mLineIndex,
        sctpRemoteMaxMessageSize: this.sctp.sctpTransport?.remoteMaxMessageSize,
      };
    }
    this.revision++;
    this.phase = "pending";
    return this.revision;
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
    const oldTransports = new Set(
      [...(this.baseline?.transceivers.values() ?? [])].map(
        (state) => state.dtlsTransport,
      ),
    );
    if (this.baseline?.sctpTransport?.dtlsTransport) {
      oldTransports.add(this.baseline.sctpTransport.dtlsTransport);
    }
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

    for (const [transceiver, state] of baseline.transceivers) {
      transceiver.mid = state.mid;
      transceiver.mLineIndex = state.mLineIndex;
      transceiver.codecs = state.codecs;
      transceiver.headerExtensions = state.headerExtensions;
      transceiver.offerDirection = state.offerDirection;
      transceiver.setCurrentDirection(state.currentDirection ?? undefined);
      transceiver.stopping = state.stopping;
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
      for (const ssrc of Object.keys(transceiver.receiver.trackBySSRC)) {
        delete transceiver.receiver.trackBySSRC[ssrc];
      }
      Object.assign(transceiver.receiver.trackBySSRC, state.receiverBySsrc);
      for (const rid of Object.keys(transceiver.receiver.trackByRID)) {
        delete transceiver.receiver.trackByRID[rid];
      }
      Object.assign(transceiver.receiver.trackByRID, state.receiverByRid);
      this.transceivers.restoreNotifiedRemoteTrack(
        transceiver,
        state.notifiedRemoteTrack,
      );
      const currentMedia = this.sdp.currentRemoteDescription?.media.find(
        (media) => media.rtp.muxId === state.mid,
      );
      if (currentMedia?.port !== undefined && currentMedia.port !== 0) {
        transceiver.receiver.prepareReceive(
          this.transceivers.getRemoteRtpParams(currentMedia, transceiver),
        );
      }
    }

    const orphanTransports = new Set<RTCDtlsTransport>();
    for (const transport of this.pendingOnlyTransports) {
      orphanTransports.add(transport);
    }
    for (const transceiver of this.remoteCreated) {
      if (transceiver.sender.track) {
        transceiver.mid = null;
        transceiver.mLineIndex = undefined;
        continue;
      }
      orphanTransports.add(transceiver.dtlsTransport);
      this.transceivers.removeRemoteTransceiver(transceiver);
    }
    this.transceivers.restoreTransceiverOrder(baseline.orderedTransceivers);
    this.router.ssrcTable = baseline.ssrcTable;
    this.router.ridTable = baseline.ridTable;
    this.router.extIdUriMap = baseline.extIdUriMap;

    if (
      this.sctp.sctpTransport &&
      this.sctp.sctpTransport !== baseline.sctpTransport
    ) {
      await this.sctp.sctpTransport.stop();
    }
    this.sctp.sctpTransport = baseline.sctpTransport;
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
    if (keepBaseline) {
      this.remoteCreated.clear();
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

  private cleanup() {
    this.baseline = undefined;
    this.remoteCreated.clear();
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
    };
  }
}
