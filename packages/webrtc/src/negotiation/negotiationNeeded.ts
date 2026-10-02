import type { RTCSignalingState } from "../types/domain";

/**
 * W3C negotiation-needed bookkeeping for one RTCPeerConnection.
 *
 * Every change that needs negotiation gets a sequence number. A local offer
 * carries the changes made before it was created, and those count as
 * negotiated once its answer commits (a rollback discards them). The event
 * fires at most once per task, only in `stable`, and only for changes no
 * committed offer carried.
 */
export class NegotiationNeeded {
  /** W3C [[NegotiationNeeded]]. */
  flag = false;
  /** A change arrived outside `stable`: re-evaluate when it returns there. */
  recheck = false;
  /** Coalesces the changes of one task into a single event. */
  private scheduled = false;
  /** Sequence number of the latest change that needs negotiation. */
  private changeSeq = 0;
  /** Changes carried by a local offer whose answer committed. */
  private negotiatedSeq = 0;
  /** Changes carried by the applied local offer (discarded on rollback). */
  private pendingOfferSeq?: number;
  /** Changes carried by the last created offer. */
  private createdOfferSeq = 0;

  constructor(
    private readonly host: {
      signalingState: () => RTCSignalingState;
      isClosed: () => boolean;
      /** Created offers/answers no longer reflect the state. */
      invalidate: () => void;
      fire: () => void;
    },
  ) {}

  /** Record a change that needs negotiation and schedule the event. */
  change() {
    this.changeSeq++;
    this.schedule();
  }

  /** Schedule the event if unnegotiated changes remain (also on return to stable). */
  schedule() {
    this.host.invalidate();
    this.recheck = true;
    if (
      this.flag ||
      this.scheduled ||
      this.host.signalingState() !== "stable"
    ) {
      return;
    }
    this.recheck = false;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.host.isClosed()) return;
      if (this.negotiatedSeq >= this.changeSeq) {
        // 発火前に適用された local offer が変更をすべて含んでいる
        return;
      }
      if (this.host.signalingState() !== "stable") {
        // stable に戻った時点で改めて判定する
        this.recheck = true;
        return;
      }
      this.flag = true;
      this.host.fire();
    });
  }

  /** `createOffer`: the offer carries every change made so far. */
  noteCreatedOffer() {
    this.createdOfferSeq = this.changeSeq;
  }

  /** The created offer was applied as the pending local offer. */
  noteAppliedOffer() {
    this.pendingOfferSeq = this.createdOfferSeq;
  }

  /** The pending local offer was rolled back (explicitly or implicitly). */
  discardPendingOffer() {
    this.pendingOfferSeq = undefined;
  }

  /** The answer to the pending local offer committed its changes. */
  commitPendingOffer() {
    if (this.pendingOfferSeq == undefined) return;
    this.negotiatedSeq = Math.max(this.negotiatedSeq, this.pendingOfferSeq);
    this.pendingOfferSeq = undefined;
  }
}
