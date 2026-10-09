import type {
  RTCRtpCodecParameters,
  RTCRtpTransceiver,
  RtpRouter,
  TransceiverManager,
} from "../media";
import type { NegotiationTransaction } from "../negotiationTransaction";
import type { SctpTransportManager } from "../sctpManager";
import type {
  GroupDescription,
  MediaDescription,
  SessionDescription,
} from "../sdp";
import type { SDPManager } from "../sdpManager";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { RTCIceTransport } from "../transport/ice";
import type { RTCSctpTransport } from "../transport/sctp";

type RemoteMediaEntry = {
  remoteMedia: MediaDescription;
  index: number;
  transceiver?: RTCRtpTransceiver;
  sctpTransport?: RTCSctpTransport;
};

/** What applying the m-lines of a remote description left for the caller. */
export type RemoteMediaPlan = {
  /** A re-offer or pranswer on a live session keeps the current transports. */
  preserveCurrentTransport: boolean;
  /**
   * Live transport and media stop operations. They run only after every
   * m-line applied without error, so a failure leaves the ICE generation,
   * selected pair and DTLS/SCTP bindings untouched.
   */
  transportUpdates: (() => void)[];
  /** Transports whose remote generation ended (run after every candidate). */
  endOfCandidates: RTCIceTransport[];
  /** Pranswer credentials for a transport with a staged ICE restart. */
  provisionalIce: [RTCIceTransport, MediaDescription][];
  /** Transceivers associated with an m-line of the description. */
  associated: Set<RTCRtpTransceiver>;
};

/**
 * Applies the m-lines of a remote description inside the negotiation
 * transaction: associates each m-line with a transceiver or the SCTP
 * transport, decides the BUNDLE transport ownership, applies RTP / SCTP
 * parameters (accept or mark rejected), and plans the transport parameter
 * updates the caller runs after every fallible step.
 */
export class RemoteMediaApplication {
  constructor(
    private readonly sdp: SDPManager,
    private readonly transceivers: TransceiverManager,
    private readonly sctp: SctpTransportManager,
    private readonly router: RtpRouter,
    private readonly negotiation: NegotiationTransaction,
    private readonly host: {
      createSctpTransport: () => RTCSctpTransport;
      /** The transport a new transceiver starts on. */
      createTransport: () => RTCDtlsTransport;
      /** An independent transport (own ICE credentials) for ownership. */
      createOwnerTransport: () => RTCDtlsTransport;
      onRemoteTransceiverAdded: (transceiver: RTCRtpTransceiver) => void;
    },
  ) {}

  /** Resolve all m-line codecs without mutating the current transaction. */
  planCodecs(remoteSdp: SessionDescription) {
    const associated = new Set<RTCRtpTransceiver>();
    return this.transceivers.planRemoteRtpCodecs(
      remoteSdp,
      (remoteMedia, index) => {
        const transceiver = this.findTransceiver(
          remoteMedia,
          index,
          associated,
        );
        if (transceiver) associated.add(transceiver);
        return transceiver;
      },
    );
  }

  apply(
    remoteSdp: SessionDescription,
    codecPlan: Map<number, RTCRtpCodecParameters[]> = new Map(),
  ): RemoteMediaPlan {
    const bundleGroups =
      this.sdp.bundlePolicy === "disable"
        ? []
        : remoteSdp.group.filter((group) => group.semantic === "BUNDLE");
    const preserveCurrentTransport =
      (remoteSdp.type === "offer" || remoteSdp.type === "pranswer") &&
      !!this.sdp.currentRemoteDescription;
    const plan: RemoteMediaPlan = {
      preserveCurrentTransport,
      transportUpdates: [],
      endOfCandidates: [],
      provisionalIce: [],
      associated: new Set(),
    };

    const entries = this.associate(remoteSdp, plan.associated);
    this.assignTransports(
      remoteSdp,
      entries,
      bundleGroups,
      preserveCurrentTransport,
    );
    const accepted = this.accept(remoteSdp, entries, plan, codecPlan);
    this.planTransportUpdates(remoteSdp, entries, bundleGroups, accepted, plan);
    return plan;
  }

  /** Associate m-lines with transceivers / the SCTP transport. */
  private associate(
    remoteSdp: SessionDescription,
    associated: Set<RTCRtpTransceiver>,
  ): RemoteMediaEntry[] {
    const entries = remoteSdp.media.map((remoteMedia, i) => {
      if (remoteMedia.kind === "application") {
        if (remoteMedia.port === 0) return { remoteMedia, index: i };
        let sctpTransport = this.sctp.sctpTransport;
        if (!sctpTransport) {
          sctpTransport = this.host.createSctpTransport();
          sctpTransport.mid = remoteMedia.rtp.muxId;
        } else if (
          sctpTransport.mid !== undefined &&
          sctpTransport.mid !== remoteMedia.rtp.muxId &&
          this.rejectedInCurrent(sctpTransport.mid)
        ) {
          // The offer reuses the rejected application position with a new
          // MID (JSEP 5.2.2): the SCTP transport follows it. A rollback
          // restores the binding with the rest of the SCTP baseline.
          sctpTransport.mid = remoteMedia.rtp.muxId;
        }
        return { remoteMedia, index: i, sctpTransport };
      }
      if (!["audio", "video"].includes(remoteMedia.kind)) {
        throw new Error("invalid media kind");
      }
      let transceiver = this.findTransceiver(remoteMedia, i, associated);
      if (!transceiver) {
        // 未知の MID の拒否済み m-line には transceiver を関連付けない
        if (remoteMedia.port === 0) return { remoteMedia, index: i };
        // JSEP 5.2.2: a new MID on an existing m-line recycles it, so the
        // transceiver that owned it is stopped. The flags are part of the
        // rollback baseline; its sender/receiver stop at the answer.
        const displaced = this.transceivers.getTransceivers().find(
          (t) =>
            !t.stopped &&
            t.mLineIndex === i &&
            !!t.mid &&
            t.mid !== remoteMedia.rtp.muxId &&
            // Only the transceiver that owns this m-line in the
            // current session is displaced by its recycling.
            this.sdp.currentRemoteDescription?.media[i]?.rtp.muxId === t.mid,
        );
        if (displaced) {
          displaced.stopping = true;
          displaced.stopped = true;
          this.router.unregisterTransceiver(displaced);
          this.negotiation.rememberDisplacedTransceiver(displaced);
        }
        // create remote transceiver
        // Not an application operation: no negotiationneeded and no
        // takeover of an inactive current transceiver. A stopped
        // transceiver at the same index is replaced, never revived.
        transceiver = this.transceivers.addTransceiver(
          remoteMedia.kind,
          this.host.createTransport(),
          { direction: "recvonly" },
          { remoteMLineIndex: i },
        );
        transceiver.mid = remoteMedia.rtp.muxId ?? null;
        this.negotiation.rememberRemoteTransceiver(transceiver);
        this.host.onRemoteTransceiverAdded(transceiver);
      } else if (transceiver.mid == null) {
        this.transceivers.associateMLine(transceiver, i);
      }
      associated.add(transceiver);
      return { remoteMedia, index: i, transceiver };
    });
    if (remoteSdp.type === "offer") {
      // 関連付けられなかった未交渉 transceiver の位置の予約を解除する
      this.transceivers.releaseUnassociatedReservations(
        associated,
        remoteSdp.media.length,
      );
    }
    return entries;
  }

  /** Whether the current session rejected (port 0) the m-line `mid`. */
  private rejectedInCurrent(mid: string) {
    return [
      this.sdp.currentLocalDescription,
      this.sdp.currentRemoteDescription,
    ].some(
      (description) =>
        description?.media.find((media) => media.rtp.muxId === mid)?.port === 0,
    );
  }

  /**
   * remote m-line に対応する transceiver を探す。MID の一致を優先し、
   * 未関連付け transceiver は同じ offer 内で異なる m-line に割り当てる。
   */
  private findTransceiver(
    remoteMedia: MediaDescription,
    index: number,
    associated: Set<RTCRtpTransceiver>,
  ) {
    const candidates = this.transceivers
      .getTransceivers()
      .filter((t) => !associated.has(t) && t.kind === remoteMedia.kind);
    const mid = remoteMedia.rtp.muxId;
    const byMid =
      mid != undefined ? candidates.find((t) => t.mid === mid) : undefined;
    if (byMid) {
      return byMid;
    }
    if (remoteMedia.port === 0) {
      return;
    }
    const unassociated = candidates.filter(
      (t) => t.mid == null && !t.stopping && !t.stopped,
    );
    return unassociated.find((t) => t.mLineIndex === index) ?? unassociated[0];
  }

  /**
   * Transport ownership. BUNDLE group ごとに 1 つの transport を共有する。remote offer
   * の所有関係は bundlePolicy によらず offer の group だけで決まり (max-bundle は自分の
   * offer にだけ効く)、異なる group や group 外の m-line とは共有しない。
   */
  private assignTransports(
    remoteSdp: SessionDescription,
    entries: RemoteMediaEntry[],
    bundleGroups: GroupDescription[],
    preserveCurrentTransport: boolean,
  ) {
    const isRemoteOffer = remoteSdp.type === "offer";
    // A current owner keeps its transport while a re-offer or pranswer is
    // pending; a staged BUNDLE topology switches it at the answer.
    const keepsCurrent = (entry: RemoteMediaEntry) =>
      preserveCurrentTransport &&
      (entry.transceiver
        ? !!entry.transceiver.currentDirection
        : !!this.sctp.sctpRemotePort);
    const membersOf = (group: GroupDescription) =>
      entries.filter(
        (entry) =>
          !!ownerOf(entry) &&
          entry.remoteMedia.port !== 0 &&
          group.items.includes(entry.remoteMedia.rtp.muxId!),
      );

    if (preserveCurrentTransport) {
      // A re-offer or pranswer on a live session keeps every current
      // owner on its transport: a new BUNDLE topology (split, merge, a new
      // owner outside the group) is prepared for the answer and switches
      // only at the commit. New members join their group tag's transport.
      for (const group of bundleGroups) {
        const members = membersOf(group);
        const tag =
          members.find(
            (entry) => entry.remoteMedia.rtp.muxId === group.items[0],
          ) ?? members[0];
        const shared = tag && ownerOf(tag)!.dtlsTransport;
        for (const entry of members) {
          const owner = ownerOf(entry)!;
          if (
            shared &&
            !keepsCurrent(entry) &&
            owner.dtlsTransport !== shared
          ) {
            owner.setDtlsTransport(shared);
          }
        }
      }
      return;
    }

    const claimed = new Set<RTCDtlsTransport>();
    // A transport that inherited another owner's ICE credentials is the
    // same ICE session on the wire, so it counts as claimed as well.
    const ufragOf = (transport: RTCDtlsTransport) =>
      transport.iceTransport.localParameters.usernameFragment;
    const isClaimed = (transport: RTCDtlsTransport) =>
      claimed.has(transport) ||
      [...claimed].some((other) => ufragOf(other) === ufragOf(transport));
    for (const group of bundleGroups) {
      const members = membersOf(group);
      if (members.length === 0) continue;
      // The tag's transport first, then any other member's.
      const preferred = [
        ...members.filter(
          (entry) => entry.remoteMedia.rtp.muxId === group.items[0],
        ),
        ...members,
      ];
      let shared = preferred
        .map((entry) => ownerOf(entry)!.dtlsTransport)
        .find(
          (transport) =>
            liveTransport(transport) &&
            (!isRemoteOffer || !isClaimed(transport)),
        );
      if (!shared) shared = this.host.createOwnerTransport();
      claimed.add(shared);
      for (const entry of members) {
        const owner = ownerOf(entry)!;
        if (owner.dtlsTransport !== shared) owner.setDtlsTransport(shared);
      }
    }
    if (isRemoteOffer) {
      // group 外 (group のない offer を含む) で受け入れる m-line は、max-bundle でも
      // 独立した transport と ICE credentials を持つ
      for (const entry of entries) {
        const owner = ownerOf(entry);
        if (
          !owner ||
          entry.remoteMedia.port === 0 ||
          groupOf(bundleGroups, entry.remoteMedia.rtp.muxId)
        ) {
          continue;
        }
        if (
          !liveTransport(owner.dtlsTransport) ||
          isClaimed(owner.dtlsTransport)
        ) {
          owner.setDtlsTransport(this.host.createOwnerTransport());
        }
        claimed.add(owner.dtlsTransport);
      }
    }
  }

  /** Apply RTP / SCTP parameters: the entries accepted (not rejected). */
  private accept(
    remoteSdp: SessionDescription,
    entries: RemoteMediaEntry[],
    plan: RemoteMediaPlan,
    codecPlan: Map<number, RTCRtpCodecParameters[]>,
  ) {
    const accepted = new Set<RemoteMediaEntry>();
    for (const entry of entries) {
      const { remoteMedia, index: i, transceiver } = entry;
      if (transceiver) {
        if (remoteMedia.port !== 0) {
          if (
            this.transceivers.setRemoteRTP(
              transceiver,
              remoteMedia,
              remoteSdp.type,
              i,
              codecPlan.get(i) ?? [],
            )
          ) {
            accepted.add(entry);
          }
          continue;
        }
        // remote port 0: an offer or pranswer only marks the rejection
        // (the current pipeline keeps running until the answer); an
        // answer stops it once every fallible step has passed.
        transceiver.mLineIndex = i;
        if (transceiver.stopped) continue;
        if (remoteSdp.type === "answer") {
          plan.transportUpdates.push(() =>
            transceiver.commitStopped({ rejected: !transceiver.stopping }),
          );
        } else if (!transceiver.stopping) {
          transceiver.pendingRejection = true;
        }
      } else if (entry.sctpTransport) {
        if (!plan.preserveCurrentTransport || !this.sctp.sctpRemotePort) {
          this.sctp.setRemoteSCTP(remoteMedia, i);
        } else if (remoteSdp.type === "pranswer") {
          // A renegotiation offer leaves the current value until the answer
          // side applies it; a pranswer updates it on the kept association.
          this.sctp.updateRemoteMaxMessageSize(remoteMedia);
        }
        accepted.add(entry);
      }
    }
    return accepted;
  }

  /** Plan the ICE / DTLS parameters, candidates and role of every transport. */
  private planTransportUpdates(
    remoteSdp: SessionDescription,
    entries: RemoteMediaEntry[],
    bundleGroups: GroupDescription[],
    accepted: Set<RemoteMediaEntry>,
    plan: RemoteMediaPlan,
  ) {
    const { preserveCurrentTransport } = plan;
    // ICE / DTLS パラメータは group で最初に受け入れた member (通常は tag) から適用する
    // (codec 不一致で拒否した member のパラメータは使わない)
    const groupParamSources = new Map<GroupDescription, RemoteMediaEntry>();
    for (const group of bundleGroups) {
      for (const mid of group.items) {
        const entry = entries.find(
          (e) =>
            e.remoteMedia.rtp.muxId === mid &&
            e.remoteMedia.port !== 0 &&
            accepted.has(e),
        );
        if (entry) {
          groupParamSources.set(group, entry);
          break;
        }
      }
    }

    for (const entry of entries) {
      const { remoteMedia } = entry;
      const owner = ownerOf(entry);
      const group = groupOf(bundleGroups, remoteMedia.rtp.muxId);
      if (
        !owner ||
        remoteMedia.port === 0 ||
        // group 外の拒否 section の transport は使わない
        (!accepted.has(entry) && !group)
      ) {
        continue;
      }
      const preparedTransport = remoteMedia.rtp.muxId
        ? this.negotiation.transportByMid.get(remoteMedia.rtp.muxId)
        : undefined;
      const pendingTransport =
        preparedTransport &&
        this.negotiation.isPendingOnlyTransport(
          preparedTransport.iceTransport.id,
        )
          ? preparedTransport
          : undefined;
      const dtlsTransport =
        preserveCurrentTransport && pendingTransport
          ? pendingTransport
          : owner.dtlsTransport;
      if (!liveTransport(dtlsTransport)) continue;
      const iceTransport = dtlsTransport.iceTransport;
      const bundledNonTag = !!group && groupParamSources.get(group) !== entry;
      const ownsGeneration = !preserveCurrentTransport || !!pendingTransport;

      plan.transportUpdates.push(() => {
        if (remoteMedia.iceParams && ownsGeneration && !bundledNonTag) {
          // A rejected (port 0) m-line is not inactive media.
          const renomination = remoteSdp.media.some(
            (media) => media.port !== 0 && media.direction === "inactive",
          );
          iceTransport.setRemoteParams(remoteMedia.iceParams, renomination, {
            keepLocalCredentials: remoteSdp.type !== "offer",
          });

          // One agent full, one lite:  The full agent MUST take the controlling role, and the lite agent MUST take the controlled role
          // RFC 8445 S6.1.1
          if (
            remoteMedia.iceParams.iceLite &&
            !iceTransport.connection.iceLite
          ) {
            iceTransport.connection.iceControlling = true;
          }
        }
        if (remoteMedia.dtlsParams && ownsGeneration && !bundledNonTag) {
          dtlsTransport.setRemoteParams(remoteMedia.dtlsParams);
        }

        // # add ICE candidates
        if (ownsGeneration && !bundledNonTag) {
          remoteMedia.iceCandidates.forEach(iceTransport.addRemoteCandidate);
        }

        // End-of-candidates ends the shared generation whichever BUNDLE
        // m-line carries it; it runs after every m-line's candidates.
        if (remoteMedia.iceCandidatesComplete && ownsGeneration) {
          plan.endOfCandidates.push(iceTransport);
        }

        if (
          remoteSdp.type === "pranswer" &&
          preserveCurrentTransport &&
          !pendingTransport &&
          !bundledNonTag &&
          iceTransport.hasStagedRestart
        ) {
          plan.provisionalIce.push([iceTransport, remoteMedia]);
        }

        // # set DTLS role
        // An answer's `actpass` names no role: a live association keeps its
        // role, a new one becomes client as before.
        const keepsLiveRole =
          remoteMedia.dtlsParams?.role === "auto" &&
          ["connecting", "connected"].includes(dtlsTransport.state);
        if (
          (remoteSdp.type === "answer" || remoteSdp.type === "pranswer") &&
          remoteMedia.dtlsParams?.role &&
          !bundledNonTag &&
          !keepsLiveRole
        ) {
          dtlsTransport.role =
            remoteMedia.dtlsParams.role === "client" ? "server" : "client";
        }
      });
    }
  }
}

const ownerOf = (entry: RemoteMediaEntry) =>
  entry.transceiver ?? entry.sctpTransport;

const liveTransport = (
  transport: RTCDtlsTransport | undefined,
): transport is RTCDtlsTransport => !!transport && transport.state !== "closed";

const groupOf = (bundleGroups: GroupDescription[], mid: string | undefined) =>
  mid == undefined
    ? undefined
    : bundleGroups.find((group) => group.items.includes(mid));
