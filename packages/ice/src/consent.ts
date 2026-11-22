import {
  type FailoverThresholds,
  nextPingAt,
  type PairLiveness,
} from "./failover";
import { type Cancelable, cancelable } from "./helper";
import {
  type CandidatePair,
  CONSENT_INTERVAL,
  CONSENT_TIMEOUT,
  consentResponseTimeoutMs,
  type IceState,
  WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL,
} from "./iceBase";
import { type Address, debug } from "./imports/common";
import type { MessageIntegrityMode } from "./stun/const";
import type { Message } from "./stun/message";

const log = debug("werift-ice : packages/ice/src/consent.ts : log");

/**
 * Consent requests a session keeps open at once: the requests the shortest
 * send interval emits within `CONSENT_TIMEOUT`, so no request that can still
 * be answered in time is ended by the limit. The shortest interval is
 * failover's weak interval (900 ms), not the regular `CONSENT_INTERVAL`
 * (4 s); one extra covers the request being sent now.
 */
export const CONSENT_MAX_OUTSTANDING_REQUESTS =
  Math.ceil(
    (CONSENT_TIMEOUT * 1000) /
      WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL,
  ) + 1;

/** What the agent supplies to its `ConsentFreshness`. */
export type ConsentHost = {
  /** The selected pair: consent checks go to it. */
  selected: () => CandidatePair | undefined;
  state: () => IceState;
  setState: (state: IceState) => void;
  /** Answers of an earlier remote generation (an ICE restart) do not count. */
  remoteGeneration: () => number;
  remotePassword: () => string;
  /** A local ICE-lite agent sends no consent checks. */
  iceLite: () => boolean;
  integrityAlgorithm: () => MessageIntegrityMode | undefined;
  /**
   * The consent check for `pair`, with what the nomination mode puts on it
   * (USE-CANDIDATE, NOMINATION).
   */
  buildRequest: (pair: CandidatePair) => Message;
  /** The local ICE generation; an answer of an earlier one does not count. */
  generation?: () => number;
  /**
   * Last chance to add what the request carries (SPED L1). Returning false
   * skips this consent check.
   */
  decorateRequest?: (request: Message, pair: CandidatePair) => boolean;
  /** A valid consent response of the current session, pair and generations. */
  onResponse?: (
    response: Message,
    addr: Address,
    pair: CandidatePair,
    generation: number,
  ) => Promise<void> | void;
  /**
   * Failover of the selected pair (`FailoverMonitor`): when `enabled()`,
   * consent checks follow its pacing and report their outcome to it.
   */
  failover?: ConsentFailoverHooks;
};

/** See `ConsentHost.failover`. */
export type ConsentFailoverHooks = {
  enabled: () => boolean;
  /** The liveness the monitor keeps for `pair` (`nextPingAt`). */
  liveness: (pair: CandidatePair) => PairLiveness | undefined;
  /** The thresholds in use (`IceOptions.failover`, for `nextPingAt`). */
  thresholds: () => FailoverThresholds;
  /** A consent check of `pair` was answered. */
  responded: (pair: CandidatePair) => void;
  /** A consent check of `pair` went unanswered (its RTT-based deadline passed). */
  unanswered: (pair: CandidatePair) => void;
  /**
   * Consent expired: true when the agent takes it over (a writable backup
   * may still take the selection), false to fail the agent as without
   * failover.
   */
  expired: () => boolean;
};

/**
 * RFC 7675 consent freshness of the selected pair: a binding request every
 * `CONSENT_INTERVAL` (randomized, measured between request starts), each
 * response refreshes the consent, and `CONSENT_TIMEOUT` without one fails
 * the agent. `start()` begins a session (the successful check that selected
 * the pair counts as the first response); `stop()` ends it without changing
 * the agent's state. A session id invalidates the callbacks of an ended
 * session (restart, close, a replaced selection, expiry).
 *
 * Each request is sent once and its transaction stays open for
 * `CONSENT_TIMEOUT`: a later request does not end it, so a response that
 * comes after the next request (a round trip longer than the RTT estimate
 * or than the interval) still refreshes the consent, as RFC 7675 §5.1 allows
 * ("the response may be for a previous request"). The session keeps at most
 * {@link CONSENT_MAX_OUTSTANDING_REQUESTS} of them open, and ending the
 * session (stop, expiry, restart, close) ends them all, so a response after
 * the expiry does not bring the consent back.
 */
export class ConsentFreshness {
  /** Consent-to-send: application data may use the selected pair. */
  fresh = false;
  /** Invalidates in-flight consent callbacks on restart / close / replace / expire. */
  sessionId = 0;
  private handle?: Cancelable<void>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  /** The consent requests in flight (oldest first), one controller each. */
  private readonly outstanding = new Set<AbortController>();
  /**
   * Counts `cancelRequests()` (a role change): a request sent before it was
   * cancelled, and its failure says nothing about the path.
   */
  private requestEpoch = 0;
  /** Wakes the running session's wait up (see `recheck`). */
  private wakeLoop?: () => void;
  private readonly host: ConsentHost;

  constructor(host: ConsentHost) {
    this.host = host;
  }

  /**
   * Stop consent request cadence, expiry timer, and outstanding transactions.
   * Does not change ICE state by itself.
   */
  stop() {
    this.sessionId++;
    this.fresh = false;
    this.wakeLoop = undefined;
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.abortRequests();
    const handle = this.handle;
    this.handle = undefined;
    // Resolve after clearing the field so a stale onCancel cannot wipe a replacement.
    handle?.resolve?.();
  }

  /**
   * Cancel the consent requests in flight without ending the session (a role
   * change: they carry the old role). Their failure is not counted as
   * unanswered; the next request carries the new role.
   */
  cancelRequests() {
    this.requestEpoch++;
    this.abortRequests();
  }

  /** The consent requests still in flight (diagnostics and tests). @internal */
  get outstandingRequests() {
    return this.outstanding.size;
  }

  /** End every consent request in flight (RFC 7675: discarded on expiry). */
  private abortRequests() {
    const controllers = [...this.outstanding];
    this.outstanding.clear();
    for (const controller of controllers) controller.abort();
  }

  /**
   * Failover: compute the next request's due time again now (the selected
   * pair's path was reported gone, so it is checked at the weak interval:
   * `nextPingAt`). Without failover, or with no session, nothing happens.
   */
  recheck() {
    this.wakeLoop?.();
  }

  /**
   * Wait `ms`; rejects when `signal` aborts. `wakeup` ends the wait early
   * (resolves). Both listeners are removed when the wait ends.
   */
  private abortableDelay(
    ms: number,
    signal: AbortSignal,
    wakeup?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        wakeup?.removeEventListener("abort", onWakeup);
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, ms);
      const onAbort = () => {
        done();
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      const onWakeup = () => {
        done();
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (wakeup?.aborted) onWakeup();
      else wakeup?.addEventListener("abort", onWakeup, { once: true });
    });
  }

  /** Start a consent session on the selected pair (replaces the previous one). */
  start = () => {
    if (this.host.iceLite()) {
      return;
    }

    // Invalidate any previous consent session before starting a new one.
    this.stop();
    const sessionId = this.sessionId;
    this.fresh = true;

    const handle = cancelable<void>(async (_, __, onCancel) => {
      let canceled = false;
      const cancelEvent = new AbortController();

      const clearConsentExpiry = () => {
        if (this.expiryTimer === undefined) {
          return;
        }
        clearTimeout(this.expiryTimer);
        this.expiryTimer = undefined;
      };

      const refreshConsentExpiry = () => {
        // Only the active session may refresh the shared expiry timer.
        if (canceled || sessionId !== this.sessionId) {
          return;
        }
        clearConsentExpiry();
        this.expiryTimer = setTimeout(() => {
          this.expiryTimer = undefined;
          if (canceled || sessionId !== this.sessionId) {
            return;
          }
          if (
            this.host.state() === "closed" ||
            this.host.state() === "failed"
          ) {
            return;
          }
          log("Consent to send expired");
          // Expire independently of request cadence / failure count (RFC 7675).
          this.fresh = false;
          this.sessionId++;
          this.abortRequests();
          if (this.handle === handle) {
            this.handle = undefined;
          }
          canceled = true;
          cancelEvent.abort();
          // Failover: the agent takes over when a writable backup may still
          // take the selection (see Connection.updateLinkState).
          if (this.host.failover?.enabled() && this.host.failover.expired()) {
            return;
          }
          // Transport stays available for ICE restart; explicit close() uses "closed".
          this.host.setState("failed");
        }, CONSENT_TIMEOUT * 1000);
      };

      onCancel.once(() => {
        canceled = true;
        // Avoid clearing a replacement session's timer/handle.
        if (sessionId === this.sessionId) {
          clearConsentExpiry();
          this.abortRequests();
        }
        cancelEvent.abort();
        if (this.handle === handle) {
          this.handle = undefined;
        }
      });

      // Initial ICE check success is the first valid consent response.
      refreshConsentExpiry();

      const randomizedConsentInterval = () =>
        CONSENT_INTERVAL * (0.8 + 0.4 * Math.random()) * 1000;

      // Cadence is measured between request *starts*, not response completions.
      let nextConsentAt = Date.now() + randomizedConsentInterval();
      const isTerminalState = () =>
        this.host.state() === "closed" || this.host.state() === "failed";
      const hooks = this.host.failover;
      // Failover (D3): the next request is due at `nextPingAt` of the
      // selected pair's liveness: the consent interval while it answers and
      // receives, WEAK_OR_STABILIZING_WRITABLE_CONNECTION_PING_INTERVAL after
      // an unanswered request, and at once (no sooner than that interval)
      // when nothing was received for `receivingTimeout`
      // (WEAK_CONNECTION_RECEIVE_TIMEOUT).
      // Requests keep this pacing whatever their round trip: the next one
      // does not cancel or wait for one still in flight, so a slow response
      // still counts and a dead path is told within the D3 bound on a
      // high-RTT path too. An outcome wakes the wait up.
      let wakeup: AbortController | undefined;
      let lastSentAt = Date.now();
      let stableInterval = nextConsentAt - lastSentAt;
      const failoverDueAt = (pair: CandidatePair) => {
        const liveness = hooks?.liveness(pair);
        return liveness
          ? nextPingAt(
              liveness,
              lastSentAt,
              stableInterval,
              hooks!.thresholds(),
            )
          : lastSentAt + stableInterval;
      };
      const wake = () => wakeup?.abort();
      // When the request that gave the pair's current RTT was sent: a
      // response to an older request (responses out of order) counts in the
      // RTT totals but does not replace a newer estimate.
      let rttSampleSentAt = Number.NEGATIVE_INFINITY;
      if (hooks) this.wakeLoop = wake;

      try {
        while (
          !isTerminalState() &&
          !canceled &&
          sessionId === this.sessionId
        ) {
          // Failover: the due time follows the selected pair's liveness from
          // the first request of the session on (a path that breaks right
          // after a selection is checked once nothing arrived for
          // `receivingTimeout`, not only after the consent interval).
          const due = this.host.selected();
          if (hooks?.enabled() && due) nextConsentAt = failoverDueAt(due);
          wakeup = new AbortController();
          await this.abortableDelay(
            // Bounded for setTimeout.
            Math.min(Math.max(0, nextConsentAt - Date.now()), 2 ** 31 - 1),
            cancelEvent.signal,
            wakeup.signal,
          );
          wakeup = undefined;

          if (canceled || isTerminalState() || sessionId !== this.sessionId) {
            break;
          }

          const nominated = this.host.selected();
          if (!nominated) {
            break;
          }
          const failover = !!hooks?.enabled();
          // Failover: woken up by an outcome or something received; the due
          // time is computed again (it may have moved either way).
          if (failover) nextConsentAt = failoverDueAt(nominated);
          // Woken up for a later time.
          if (Date.now() < nextConsentAt) continue;

          const requestSentAt = Date.now();
          if (failover) {
            lastSentAt = requestSentAt;
            stableInterval = randomizedConsentInterval();
            nextConsentAt = failoverDueAt(nominated);
          } else {
            // Fix next start time before awaiting any response (independent timers).
            nextConsentAt = requestSentAt + randomizedConsentInterval();
          }
          const requestEpoch = this.requestEpoch;

          const pairId = nominated.id;
          const generation = this.host.remoteGeneration();
          const localGeneration = this.host.generation?.();
          const remotePassword = this.host.remotePassword();

          const request = this.host.buildRequest(nominated);
          if (this.host.decorateRequest?.(request, nominated) === false) {
            continue;
          }

          // Each request has its own controller: a later request leaves it
          // open (its response may come after the next request), the session
          // ends them all, and beyond the limit the oldest one ends.
          const requestAbort = new AbortController();
          this.outstanding.add(requestAbort);
          if (this.outstanding.size > CONSENT_MAX_OUTSTANDING_REQUESTS) {
            const [oldest] = this.outstanding;
            this.outstanding.delete(oldest!);
            oldest!.abort();
          }

          nominated.consentRequestsSent++;
          nominated.requestsSent++;

          // RTT-aware deadline (floor 500ms): failover counts the request
          // as unanswered once it passed without a response. It does not end
          // the transaction: that stays open for CONSENT_TIMEOUT (sent once,
          // retransmissions: 0), so a response slower than the RTT estimate
          // (the path's RTT rose, a busy event loop) still refreshes the
          // consent; ending it at the estimate would drop every response
          // once the RTT rose above it, and the estimate is only updated by
          // a response it took.
          const rttTimeout = consentResponseTimeoutMs(nominated.rtt);
          const responseTimeout = CONSENT_TIMEOUT * 1000;
          const requestStartedAt = performance.now();
          let countedUnanswered = false;
          const countUnanswered = () => {
            if (
              countedUnanswered ||
              canceled ||
              sessionId !== this.sessionId ||
              this.host.selected()?.id !== pairId ||
              // Cancelled by a role change: says nothing about the path.
              requestEpoch !== this.requestEpoch ||
              !hooks?.enabled()
            ) {
              return;
            }
            countedUnanswered = true;
            hooks.unanswered(nominated);
            wake();
          };
          // The deadline timer and its abort listener live only while the
          // request is in flight (the signal is shared by the session's
          // requests, so a listener left on it would pile up).
          let deadline: ReturnType<typeof setTimeout> | undefined;
          const settle = () => {
            if (deadline !== undefined) clearTimeout(deadline);
            deadline = undefined;
            this.outstanding.delete(requestAbort);
            requestAbort.signal.removeEventListener("abort", settle);
          };
          requestAbort.signal.addEventListener("abort", settle, {
            once: true,
          });
          if (failover) {
            deadline = setTimeout(() => {
              deadline = undefined;
              countUnanswered();
            }, rttTimeout);
          }

          // Do not await here: response wait must not stretch the 4–6s cadence.
          nominated.protocol
            .request(
              request,
              nominated.remoteAddr,
              Buffer.from(remotePassword, "utf8"),
              {
                retransmissions: 0,
                responseTimeout,
                signal: requestAbort.signal,
                integrityAlgorithm: this.host.integrityAlgorithm(),
                onRequestSent: (attempt) => {
                  if (attempt > 0) {
                    nominated.retransmissionsSent++;
                  }
                },
              },
            )
            .then(async ([response, responseAddr]) => {
              settle();
              // Accept only responses for the current pair / generation / session.
              // Address / MESSAGE-INTEGRITY / response class are enforced in Transaction + protocol.
              if (sessionId !== this.sessionId || canceled) {
                return;
              }
              const state = this.host.state();
              if (state === "closed" || state === "failed") {
                return;
              }
              if (this.host.selected()?.id !== pairId) {
                return;
              }
              if (
                this.host.remoteGeneration() !== generation ||
                this.host.generation?.() !== localGeneration
              ) {
                return;
              }
              if (this.host.remotePassword() !== remotePassword) {
                return;
              }

              const rtt = (performance.now() - requestStartedAt) / 1000; // seconds
              // Test: tests/ice/consent-network.test.ts "応答の順序が入れ替わっても受理し、古い request の RTT で新しい推定を上書きしない"
              // Test: tests/ice/selection-controller.test.ts "a response to an older check (latest: false) counts for the totals and the smoothed RTT, not the current RTT"
              const latest = requestStartedAt > rttSampleSentAt;
              if (latest) rttSampleSentAt = requestStartedAt;
              nominated.recordRoundTrip(rtt, { latest });

              nominated.responsesReceived++;
              this.fresh = true;
              refreshConsentExpiry();
              if (failover) {
                if (hooks?.enabled()) hooks.responded(nominated);
                wake();
              } else if (state === "disconnected") {
                this.host.setState("connected");
              }
              if (localGeneration !== undefined) {
                await this.host.onResponse?.(
                  response,
                  responseAddr,
                  nominated,
                  localGeneration,
                );
              }
            })
            .catch((error) => {
              settle();
              // Individual request loss is expected; keep monitoring (RFC 7675).
              if (
                sessionId === this.sessionId &&
                this.host.selected()?.id === pairId
              ) {
                log("no stun response", error);
                // Failover: counted at its deadline already, unless it
                // failed before (e.g. it could not be sent).
                if (failover && !requestAbort.signal.aborted) countUnanswered();
              }
            });
        }
      } catch (error) {
        // Abort during delay is normal on cancel / expire.
      } finally {
        if (sessionId === this.sessionId) {
          clearConsentExpiry();
        }
      }
    });
    this.handle = handle;
  };
}
