import { Event } from "../imports/common";
import type { TransportAttempt } from "./dtls-types";

/**
 * @internal Identity of the handshake / authentication attempt that owns the
 * transport's continuations.
 *
 * An ICE restart can keep the DTLS association while changing its carrier
 * generation, so every continuation captures the attempt it was started for
 * and checks {@link TransportAttempts.isCurrent} before touching state. A new
 * attempt never mutates an old one: callbacks of the previous generation
 * simply stop matching.
 */
export class TransportAttempts {
  /** Fires whenever a new attempt becomes current; readiness waiters re-check. */
  readonly onChanged = new Event<[]>();
  private counter = 0;
  private currentAttempt?: TransportAttempt;
  /** Attempt whose lower DTLS completion latch is already being awaited. */
  private handshakeWaitAttemptId?: number;

  get current(): TransportAttempt | undefined {
    return this.currentAttempt;
  }

  /** Start a new attempt for `iceGeneration`; it supersedes the current one. */
  begin(iceGeneration: number): TransportAttempt {
    const attempt: TransportAttempt = { id: ++this.counter, iceGeneration };
    this.currentAttempt = attempt;
    this.onChanged.execute();
    return attempt;
  }

  /**
   * `attempt` is still current and belongs to the live ICE generation. The
   * transport additionally treats every attempt as stale once it closed.
   */
  isCurrent(attempt: TransportAttempt, liveIceGeneration: number): boolean {
    return (
      this.currentAttempt?.id === attempt.id &&
      this.currentAttempt.iceGeneration === attempt.iceGeneration &&
      liveIceGeneration === attempt.iceGeneration
    );
  }

  /** Stop: no continuation of any attempt may resume. */
  invalidate(): void {
    this.currentAttempt = undefined;
  }

  /**
   * Claim the wait for the lower DTLS completion latch on behalf of
   * `attempt`. Returns false when that attempt already waits for it.
   */
  claimHandshakeWait(attempt: TransportAttempt): boolean {
    if (this.handshakeWaitAttemptId === attempt.id) return false;
    this.handshakeWaitAttemptId = attempt.id;
    return true;
  }
}
