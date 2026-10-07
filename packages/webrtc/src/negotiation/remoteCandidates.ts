import { createWebRtcDomException } from "../errors";
import type { NegotiationTransaction } from "../negotiationTransaction";
import type { SessionDescription } from "../sdp";
import type { SDPManager } from "../sdpManager";
import type { SecureTransportManager } from "../secureTransportManager";
import type { RTCDtlsTransport } from "../transport/dtls";
import type {
  RTCIceCandidate,
  RTCIceCandidateInit,
  RTCIceTransport,
} from "../transport/ice";
import type { RTCSignalingState } from "../types/domain";
import type { BundleTopology } from "./bundleTopology";

/**
 * The ICE generation of a candidate is its ufrag, given either as the
 * `usernameFragment` property or as the `ufrag` token of the candidate
 * string. Both forms route the same way; conflicting values are rejected.
 */
export function normalizeCandidateUfrag(
  message: RTCIceCandidate | RTCIceCandidateInit | null,
): RTCIceCandidate | RTCIceCandidateInit | null {
  if (!message) return message;
  const fromString = message.candidate?.match(/\bufrag\s+(\S+)/)?.[1];
  const fromProperty = message.usernameFragment ?? undefined;
  if (fromString && fromProperty && fromString !== fromProperty) {
    throw createWebRtcDomException(
      "OperationError",
      "Candidate ufrag does not match usernameFragment",
    );
  }
  if (!fromString || fromProperty) return message;
  const init = "toJSON" in message ? message.toJSON() : { ...message };
  return { ...init, usernameFragment: fromString };
}

/**
 * Trickle ICE for remote candidates: routes each candidate or
 * end-of-candidates to the ICE generation (current or pending) of the m-line
 * it targets, records it in that SDP and hands it to the live, pending-only or
 * provisional checklist. Candidates added before any remote description wait
 * in a queue (werift convenience; the WPT runner keeps the strict rejection).
 */
export class RemoteCandidates {
  /** Candidates added before a remote description was applied. */
  readonly queued: Array<RTCIceCandidate | RTCIceCandidateInit | null> = [];

  constructor(
    private readonly sdp: SDPManager,
    private readonly secure: SecureTransportManager,
    private readonly negotiation: NegotiationTransaction,
    private readonly topology: BundleTopology,
    private readonly host: {
      signalingState: () => RTCSignalingState;
      hasRemoteDescription: () => boolean;
    },
  ) {}

  /** Route a trickled candidate or end-of-candidates to its ICE generation. */
  async apply(candidateMessage: RTCIceCandidate | RTCIceCandidateInit | null) {
    const current = this.sdp.currentRemoteDescription;
    const pending = this.sdp.pendingRemoteDescription;
    const ufrag = candidateMessage?.usernameFragment;
    // The generation is decided by the m-line the candidate targets: with a
    // partial BUNDLE split one m-line may keep the current ufrag while another
    // moves to a new one within the same pending description.
    const sdpMid = candidateMessage?.sdpMid;
    const sdpMLineIndex = candidateMessage?.sdpMLineIndex;
    const targetMedia = (description: SessionDescription) =>
      typeof sdpMid === "string"
        ? description.media.filter((media) => media.rtp.muxId === sdpMid)
        : typeof sdpMLineIndex === "number"
          ? description.media.slice(sdpMLineIndex, sdpMLineIndex + 1)
          : description.media;
    const matchesUfrag = (description: SessionDescription) =>
      targetMedia(description).some(
        (media) => media.iceParams?.usernameFragment === ufrag,
      );
    const sdp =
      ufrag &&
      current &&
      matchesUfrag(current) &&
      (!pending || !matchesUfrag(pending))
        ? current
        : (pending ?? current);
    if (!sdp) {
      return;
    }
    // A new remote generation is only a proposal during a re-offer. Keep its
    // trickle data in the pending SDP until the final answer activates it.
    const stageOnly =
      sdp === pending &&
      !!current &&
      (pending?.type === "offer" || pending?.type === "pranswer");
    const appliedCandidate = await this.secure.addIceCandidate(
      sdp,
      candidateMessage,
      !stageOnly,
    );
    const remoteDescription = sdp;
    if (!remoteDescription || !appliedCandidate) {
      return;
    }
    if (stageOnly) {
      const targets = new Set(
        appliedCandidate.mediaIndices
          .map((index) =>
            this.negotiation.transportByMid.get(
              remoteDescription.media[index]?.rtp.muxId ?? "",
            ),
          )
          .filter(
            (transport): transport is RTCDtlsTransport =>
              !!transport &&
              this.negotiation.isPendingOnlyTransport(
                transport.iceTransport.id,
              ),
          ),
      );
      for (const transport of targets) {
        transport.iceTransport.deliverRemoteCandidate(
          appliedCandidate.kind === "end-of-candidates"
            ? undefined
            : appliedCandidate.candidate,
        );
      }
      if (current) {
        await this.deliverSameGenerationCandidate(
          remoteDescription,
          current,
          appliedCandidate,
        );
      }
      if (
        this.host.signalingState() === "have-local-pranswer" ||
        this.host.signalingState() === "have-remote-pranswer"
      ) {
        const provisional = new Set(
          appliedCandidate.mediaIndices
            .map(
              (index) =>
                this.topology.currentTransportForMid(
                  remoteDescription.media[index]?.rtp.muxId ?? "",
                )?.iceTransport,
            )
            .filter(
              (transport): transport is RTCIceTransport =>
                !!transport?.hasStagedRestart &&
                !this.negotiation.isPendingOnlyTransport(transport.id),
            ),
        );
        for (const transport of provisional) {
          transport.deliverProvisionalRemoteCandidate(
            appliedCandidate.kind === "end-of-candidates"
              ? undefined
              : appliedCandidate.candidate,
          );
        }
      }
    }

    if (appliedCandidate.kind === "end-of-candidates") {
      for (const mediaIndex of appliedCandidate.mediaIndices) {
        const media = remoteDescription.media[mediaIndex];
        if (media) {
          media.iceCandidatesComplete = true;
        }
      }
      // A pending SDP becomes current at the answer, so it is aligned too.
      this.completeSharedTransportMedia(
        remoteDescription,
        appliedCandidate.mediaIndices,
      );
      return;
    }

    for (const mediaIndex of appliedCandidate.mediaIndices) {
      const media = remoteDescription.media[mediaIndex];
      if (!media) {
        continue;
      }
      media.iceCandidates.push(appliedCandidate.candidate);
    }
  }

  /**
   * A re-offer or pranswer that keeps the current transports may still carry
   * new candidates or end-of-candidates for an m-line whose ufrag is
   * unchanged. They belong to the live generation too, so they reach the live
   * checklist and the current SDP (once, and not after its end-of-candidates),
   * exactly like trickled ones. A pending-only transport receives its own.
   */
  async deliverSameGenerationDescription(proposal: SessionDescription) {
    const current = this.sdp.currentRemoteDescription;
    if (!current) return;
    const shared = [...proposal.media.entries()].filter(([, media]) => {
      if (media.port === 0) return false;
      const prepared = this.negotiation.transportByMid.get(
        media.rtp.muxId ?? "",
      );
      return !(
        prepared &&
        this.negotiation.isPendingOnlyTransport(prepared.iceTransport.id)
      );
    });
    // Candidates first (a non-tag BUNDLE member carries none of its own),
    // then end-of-candidates from any m-line, since it ends the shared
    // generation for the whole group.
    for (const [index, media] of shared) {
      if (this.topology.isBundledNonTag(proposal, media.rtp.muxId)) continue;
      for (const candidate of media.iceCandidates) {
        await this.deliverSameGenerationCandidate(proposal, current, {
          kind: "candidate",
          candidate,
          mediaIndices: [index],
        });
      }
    }
    for (const [index, media] of shared) {
      if (!media.iceCandidatesComplete) continue;
      await this.deliverSameGenerationCandidate(proposal, current, {
        kind: "end-of-candidates",
        mediaIndices: [index],
      });
    }
  }

  /**
   * End-of-candidates ends an ICE generation on its transport, not one
   * m-line: every m-line of `sdp` on the same finished transport with the
   * same ufrag as `completed` (the rest of its BUNDLE group) is marked
   * complete, so the SDP never promises more candidates to it.
   */
  completeSharedTransportMedia(sdp: SessionDescription, completed: number[]) {
    // The current description is laid out on the committed transports; a
    // pending proposal (a BUNDLE split) maps its MIDs elsewhere meanwhile.
    const transportFor = (mid: string) =>
      (sdp === this.sdp.currentRemoteDescription
        ? this.topology.liveTransportForMid(mid)
        : this.topology.currentTransportForMid(mid)
      )?.iceTransport;
    const generations = completed
      .map((index) => {
        const media = sdp.media[index];
        const transport = transportFor(media?.rtp.muxId ?? "");
        const ufrag = media?.iceParams?.usernameFragment;
        // Only the generation that actually ended on the transport counts; a
        // pending restart ufrag on the same transport is still open.
        return transport?.connection.remoteCandidatesEnd &&
          transport.connection.remoteUsername === ufrag
          ? { transport, ufrag }
          : undefined;
      })
      .filter((generation) => !!generation?.ufrag);
    for (const media of sdp.media) {
      const transport = transportFor(media.rtp.muxId ?? "");
      if (
        generations.some(
          (generation) =>
            generation?.transport === transport &&
            generation?.ufrag === media.iceParams?.usernameFragment,
        )
      ) {
        media.iceCandidatesComplete = true;
      }
    }
  }

  /**
   * A candidate trickled for a pending re-offer whose m-line keeps the current
   * ufrag belongs to the live ICE generation as well. Besides the pending SDP,
   * it is recorded in the current SDP and handed to the live checklist once,
   * so the committed session can use it while the proposal is pending.
   */
  private async deliverSameGenerationCandidate(
    pending: SessionDescription,
    current: SessionDescription,
    applied: NonNullable<
      Awaited<ReturnType<SecureTransportManager["addIceCandidate"]>>
    >,
  ) {
    for (const index of applied.mediaIndices) {
      const mid = pending.media[index]?.rtp.muxId;
      const ufrag = pending.media[index]?.iceParams?.usernameFragment;
      const currentMedia = current.media.find(
        (media) => media.rtp.muxId === mid,
      );
      const iceTransport = mid
        ? this.topology.currentTransportForMid(mid)?.iceTransport
        : undefined;
      if (
        !ufrag ||
        !currentMedia ||
        currentMedia.iceParams?.usernameFragment !== ufrag ||
        !iceTransport ||
        this.negotiation.isPendingOnlyTransport(iceTransport.id) ||
        iceTransport.connection.remoteUsername !== ufrag ||
        // RFC 8838: a generation that signalled end-of-candidates is complete,
        // whichever BUNDLE m-line of the shared transport carried it.
        currentMedia.iceCandidatesComplete ||
        iceTransport.connection.remoteCandidatesEnd
      ) {
        continue;
      }
      if (applied.kind === "end-of-candidates") {
        currentMedia.iceCandidatesComplete = true;
        iceTransport.deliverRemoteCandidate(undefined);
        this.completeSharedTransportMedia(current, [
          current.media.indexOf(currentMedia),
        ]);
        continue;
      }
      const text = applied.candidate.toJSON().candidate;
      if (
        currentMedia.iceCandidates.some(
          (existing) => existing.toJSON().candidate === text,
        )
      ) {
        continue;
      }
      currentMedia.iceCandidates.push(applied.candidate);
      iceTransport.deliverRemoteCandidate(applied.candidate);
    }
  }

  /**
   * Candidates queued before any remote description are checked against the
   * description during validation, so a bad one rejects setRemoteDescription
   * before any state changes and before any application event fires. The rejected
   * candidates leave the queue: their addIceCandidate already resolved, and a
   * retry of the same description must not fail on them again.
   */
  async validateQueued(sdp: SessionDescription) {
    let firstError: unknown;
    for (const candidate of [...this.queued]) {
      try {
        await this.secure.addIceCandidate(sdp, candidate ?? null, false);
      } catch (error) {
        firstError ??= error;
        this.queued.splice(this.queued.indexOf(candidate), 1);
      }
    }
    if (firstError) throw firstError;
  }

  /** Apply the queued candidates once a remote description exists. */
  async flushQueued() {
    while (this.queued.length > 0 && this.host.hasRemoteDescription()) {
      const candidate = this.queued.shift();
      await this.apply(candidate ?? null);
    }
  }
}
