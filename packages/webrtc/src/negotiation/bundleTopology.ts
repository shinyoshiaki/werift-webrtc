import { SCTP_STATE } from "../../../sctp/src";
import { createWebRtcDomException } from "../errors";
import type { TransceiverManager } from "../media";
import type { NegotiationTransaction } from "../negotiationTransaction";
import type { SctpTransportManager } from "../sctpManager";
import type { GroupDescription, SessionDescription } from "../sdp";
import type { SDPManager } from "../sdpManager";
import type { RTCDtlsTransport } from "../transport/dtls";
import type { RTCSignalingState } from "../types/domain";

/**
 * BUNDLE ownership of a negotiation: which transport each m-line uses for a
 * proposal. Every BUNDLE group counts (RFC 8843 allows several); the tag of a
 * group owns the transport its members share. A proposal that changes the
 * topology (split, merge, new owner) gets its transports prepared in the
 * negotiation transaction and switches only at the commit.
 */
export class BundleTopology {
  constructor(
    private readonly sdp: SDPManager,
    private readonly transceivers: TransceiverManager,
    private readonly sctp: SctpTransportManager,
    private readonly negotiation: NegotiationTransaction,
    /** A new transport with its own ICE credentials. */
    private readonly createTransport: () => RTCDtlsTransport,
    /** The PeerConnection was closed (checked after every await). */
    private readonly isClosed: () => boolean = () => false,
  ) {}

  /**
   * After an await while preparing transports: a close() that ran meanwhile
   * already disposed the negotiation, so the transports this preparation
   * created are stopped here and it fails instead of creating more.
   */
  private async assertOpen(created: RTCDtlsTransport[]) {
    if (!this.isClosed()) return;
    await Promise.allSettled(created.map((transport) => transport.stop()));
    throw createWebRtcDomException(
      "InvalidStateError",
      "RTCPeerConnection is closed",
    );
  }

  /**
   * BUNDLE tag (first MID) of the group of `description` that contains `mid`.
   * Every group counts, not only the first one.
   */
  bundleTagOf(description: SessionDescription, mid?: string | null) {
    if (this.sdp.bundlePolicy === "disable" || mid == undefined) return;
    return description.group.find(
      (group) => group.semantic === "BUNDLE" && group.items.includes(mid),
    )?.items[0];
  }

  /** `mid` is a BUNDLE member that shares its group tag's transport. */
  isBundledNonTag(description: SessionDescription, mid?: string | null) {
    const tag = this.bundleTagOf(description, mid);
    return tag !== undefined && tag !== mid;
  }

  /** The transport prepared for `mid` by the pending proposal, else its live one. */
  currentTransportForMid(mid: string) {
    return (
      this.negotiation.transportByMid.get(mid) ??
      this.transceivers.getTransceivers().find((t) => t.mid === mid)
        ?.dtlsTransport ??
      (this.sctp.sctpTransport?.mid === mid
        ? this.sctp.sctpTransport.dtlsTransport
        : undefined)
    );
  }

  /** Live transport of every m-line (transceiver or SCTP) that has a MID. */
  /** The transport the committed session uses for `mid` (ignoring a pending proposal). */
  liveTransportForMid(mid: string) {
    return this.liveTransportByMid().get(mid);
  }

  private liveTransportByMid() {
    const byMid = new Map<string, RTCDtlsTransport>();
    for (const transceiver of this.transceivers.getTransceivers()) {
      if (transceiver.mid)
        byMid.set(transceiver.mid, transceiver.dtlsTransport);
    }
    const sctp = this.sctp.sctpTransport;
    if (sctp?.mid) byMid.set(sctp.mid, sctp.dtlsTransport);
    return byMid;
  }

  /**
   * Prepare the transports a local offer needs without touching the pending
   * transaction. A replacement offer is staged here first, so a failure (for
   * example ICE gathering of a new BUNDLE owner) stops only what was staged
   * and leaves the previous pending offer, its transports and the signaling
   * state as they were. `assigned` are the transports of transceivers the
   * offer associates that are not associated yet (it is not applied yet).
   * Only the new transports are kept: an owner that reuses a live transport
   * takes the one it is bound to when the offer is installed.
   */
  async stageLocalOffer(
    offer: SessionDescription,
    assigned: ReadonlyMap<string, RTCDtlsTransport> = new Map(),
  ) {
    const currentByMid = this.liveTransportByMid();
    for (const [mid, transport] of assigned) {
      if (!currentByMid.has(mid)) currentByMid.set(mid, transport);
    }
    // Until the peer has accepted BUNDLE in the committed session, an offered
    // group is only a proposal under max-compat / balanced: a member keeps
    // its own transport and candidates and the answer that accepts the group
    // merges them (RFC 8843 section 7.2). It shares its tag's transport in
    // the offer under max-bundle, once the peer bundles, or when it already
    // does (or has no transport of its own yet).
    const peerBundles = !!this.sdp.currentRemoteDescription?.group.some(
      (group) => group.semantic === "BUNDLE",
    );
    const ownerByMid = new Map<string, string>();
    for (const media of offer.media) {
      const mid = media.rtp.muxId;
      if (media.port === 0 || !mid) continue;
      const tag = this.bundleTagOf(offer, mid) ?? mid;
      const own = currentByMid.get(mid);
      const shared =
        tag === mid ||
        this.sdp.bundlePolicy === "max-bundle" ||
        peerBundles ||
        !own ||
        own === currentByMid.get(tag);
      ownerByMid.set(mid, shared ? tag : mid);
    }

    // Select one transport per proposed owner, starting with the transport
    // already bound to the BUNDLE tag. Every member then follows that owner.
    const ownerTransport = new Map<
      string,
      { transport: RTCDtlsTransport; pendingOnly: boolean }
    >();
    const used = new Set<RTCDtlsTransport>();
    const created: RTCDtlsTransport[] = [];
    try {
      for (const owner of new Set(ownerByMid.values())) {
        let transport = currentByMid.get(owner);
        let pendingOnly = false;
        if (!transport || used.has(transport)) {
          transport = this.createTransport();
          created.push(transport);
          pendingOnly = true;
          await transport.iceTransport.gather();
          await this.assertOpen(created);
        }
        used.add(transport);
        ownerTransport.set(owner, { transport, pendingOnly });
      }
    } catch (error) {
      await Promise.allSettled(created.map((transport) => transport.stop()));
      throw error;
    }

    return [...ownerByMid].map(([mid, owner]) => ({
      mid,
      owner,
      ...ownerTransport.get(owner)!,
    }));
  }

  /** Hand staged local-offer transports to the pending transaction. */
  installLocalOffer(
    offer: SessionDescription,
    staged: Awaited<ReturnType<BundleTopology["stageLocalOffer"]>>,
  ) {
    const live = this.liveTransportByMid();
    for (const {
      mid,
      owner,
      transport: stagedTransport,
      pendingOnly,
    } of staged) {
      if (pendingOnly) {
        this.negotiation.prepareTransport(offer, mid, stagedTransport, true);
        this.negotiation.prepareTransport(offer, mid, stagedTransport);
        continue;
      }
      // The live transport the owner is bound to now (retiring a first
      // negotiation's provisional connection may have replaced it).
      const transport = live.get(owner) ?? stagedTransport;
      this.negotiation.prepareTransport(offer, mid, transport);
    }
  }

  /**
   * Decide which live transport each proposed BUNDLE owner of a re-offer would
   * reuse. `undefined` means the owner needs a new pending transport.
   */
  planPending(offer: SessionDescription) {
    const ownerByMid = new Map<string, string>();
    for (const media of offer.media) {
      if (media.port === 0 || !media.rtp.muxId) continue;
      if (
        (media.kind === "audio" || media.kind === "video") &&
        this.transceivers
          .getTransceivers()
          .find((transceiver) => transceiver.mid === media.rtp.muxId)?.codecs
          .length === 0
      )
        continue;
      ownerByMid.set(
        media.rtp.muxId,
        this.bundleTagOf(offer, media.rtp.muxId) ?? media.rtp.muxId,
      );
    }
    const currentByMid = this.liveTransportByMid();
    // An ICE restart alone keeps the owner's DTLS transport; its new ICE
    // generation is staged on that transport's ICE connection.
    const owners = new Map<string, { reuse?: RTCDtlsTransport }>();
    const used = new Set<RTCDtlsTransport>();
    for (const owner of new Set(ownerByMid.values())) {
      const transport = currentByMid.get(owner);
      if (!transport || used.has(transport)) {
        owners.set(owner, {});
      } else {
        owners.set(owner, { reuse: transport });
        used.add(transport);
      }
    }
    return { ownerByMid, owners };
  }

  /** Reject a re-offer whose topology would move a connected SCTP association. */
  assertPendingSctpBinding(offer: SessionDescription) {
    const sctp = this.sctp.sctpTransport;
    if (
      !this.sdp.currentRemoteDescription ||
      !sctp?.mid ||
      sctp.sctp?.associationState !== SCTP_STATE.ESTABLISHED
    )
      return;
    const { ownerByMid, owners } = this.planPending(offer);
    const owner = ownerByMid.get(sctp.mid);
    if (owner === undefined) return;
    if (owners.get(owner)?.reuse !== sctp.dtlsTransport) {
      throw createWebRtcDomException(
        "InvalidModificationError",
        "Moving a connected SCTP association to another DTLS transport is unsupported",
      );
    }
  }

  /** Keep a re-offer's proposed BUNDLE owners separate from the live bindings. */
  async preparePending() {
    const offer = this.sdp.pendingRemoteDescription;
    if (
      !offer ||
      offer.type !== "offer" ||
      this.negotiation.preparedDescription === offer
    )
      return;
    if (!this.sdp.currentRemoteDescription) return;

    this.assertPendingSctpBinding(offer);
    const { ownerByMid, owners } = this.planPending(offer);
    const created: RTCDtlsTransport[] = [];
    try {
      const ownerTransports = new Map<string, RTCDtlsTransport>();
      for (const [owner, plan] of owners) {
        let transport = plan.reuse;
        if (!transport) {
          transport = this.createTransport();
          created.push(transport);
          this.negotiation.prepareTransport(offer, owner, transport, true);
          await transport.iceTransport.gather();
          await this.assertOpen(created);
        }
        ownerTransports.set(owner, transport);
      }
      for (const [mid, owner] of ownerByMid) {
        this.negotiation.prepareTransport(
          offer,
          mid,
          ownerTransports.get(owner)!,
        );
      }
    } catch (error) {
      await this.negotiation.discardPreparedTransports();
      throw error;
    }
  }

  /** The answer commits: every m-line moves to the transport prepared for it. */
  applyPending() {
    const transports = this.negotiation.transportByMid;
    if (transports.size === 0) return;
    for (const transceiver of this.transceivers.getTransceivers()) {
      const transport = transceiver.mid && transports.get(transceiver.mid);
      if (transport) transceiver.setDtlsTransport(transport);
    }
    const sctp = this.sctp.sctpTransport;
    if (sctp?.mid) {
      const transport = transports.get(sctp.mid);
      if (transport) sctp.setDtlsTransport(transport);
    }
  }

  /**
   * remote answer / pranswer の検証 (offerer 側、状態を変更する前に実行する)。
   * local offer で 1 つの transport を共有した m-line を、answer が同じ BUNDLE group に置かずに
   * 異なる ICE credentials で受け入れることはできない (RFC 8843 7.3.2)。共有 transport は分割できず、
   * 新しい transport を作ると offer で渡した ICE credentials とも一致しなくなる。
   * group の記述が MID と一致しなくても remote の ICE credentials が同じなら、同じ transport のまま扱う。
   */
  assertAnswerKeepsSharedTransports(
    answer: SessionDescription,
    signalingState: RTCSignalingState,
  ) {
    if (
      !["answer", "pranswer"].includes(answer.type) ||
      !["have-local-offer", "have-remote-pranswer"].includes(signalingState) ||
      this.sdp.bundlePolicy === "disable"
    ) {
      return;
    }
    const answerGroups = answer.group.filter((g) => g.semantic === "BUNDLE");
    const byTransport = new Map<
      RTCDtlsTransport,
      { group?: GroupDescription; credentials: string }
    >();
    const sctp = this.sctp.sctpTransport;
    for (const media of answer.media) {
      const mid = media.rtp.muxId;
      if (media.port === 0 || mid == undefined) {
        continue;
      }
      const owner =
        media.kind === "application"
          ? sctp?.mid === mid
            ? sctp
            : undefined
          : this.transceivers
              .getTransceivers()
              .find((t) => t.mid === mid && !t.stopped);
      // local offer 用に準備した transport があれば、それが offer での所有 transport
      const transport =
        this.negotiation.transportByMid.get(mid) ?? owner?.dtlsTransport;
      if (!transport) {
        continue;
      }
      const current = {
        group: answerGroups.find((g) => g.items.includes(mid)),
        credentials: `${media.iceParams?.usernameFragment}:${media.iceParams?.password}`,
      };
      const first = byTransport.get(transport);
      if (!first) {
        byTransport.set(transport, current);
        continue;
      }
      const sameGroup = !!current.group && current.group === first.group;
      if (!sameGroup && current.credentials !== first.credentials) {
        throw createWebRtcDomException(
          "InvalidAccessError",
          `mid=${mid} shares a transport in the local offer but the remote ${answer.type} moves it out of that BUNDLE group`,
        );
      }
    }
  }
}
