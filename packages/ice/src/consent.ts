import { type Cancelable, cancelable } from "./helper";
import {
  type CandidatePair,
  CONSENT_INTERVAL,
  CONSENT_TIMEOUT,
  consentResponseTimeoutMs,
  type IceState,
} from "./iceBase";
import { type Address, debug } from "./imports/common";
import type { MessageIntegrityMode } from "./stun/const";
import type { Message } from "./stun/message";

const log = debug("werift-ice : packages/ice/src/consent.ts : log");

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
  /** Local generation; an answer received after a local restart does not count. */
  generation: () => number;
  /**
   * Last chance to add to the consent request (SPED); `false` skips this
   * round's request.
   */
  decorateRequest: (request: Message, pair: CandidatePair) => boolean;
  /** An accepted consent response (SPED carry). */
  onResponse: (
    response: Message,
    addr: Address,
    pair: CandidatePair,
    generation: number,
  ) => Promise<void> | void;
};

/**
 * RFC 7675 consent freshness of the selected pair: a binding request every
 * `CONSENT_INTERVAL` (randomized, measured between request starts), each
 * response refreshes the consent, and `CONSENT_TIMEOUT` without one fails
 * the agent. `start()` begins a session (the successful check that selected
 * the pair counts as the first response); `stop()` ends it without changing
 * the agent's state. A session id invalidates the callbacks of an ended
 * session (restart, close, a replaced selection, expiry).
 */
export class ConsentFreshness {
  /** Consent-to-send: application data may use the selected pair. */
  fresh = false;
  /** Invalidates in-flight consent callbacks on restart / close / replace / expire. */
  sessionId = 0;
  private handle?: Cancelable<void>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private requestAbort?: AbortController;
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
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.requestAbort?.abort();
    this.requestAbort = undefined;
    const handle = this.handle;
    this.handle = undefined;
    // Resolve after clearing the field so a stale onCancel cannot wipe a replacement.
    handle?.resolve?.();
  }

  private abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
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
          this.requestAbort?.abort();
          this.requestAbort = undefined;
          if (this.handle === handle) {
            this.handle = undefined;
          }
          canceled = true;
          cancelEvent.abort();
          // Transport stays available for ICE restart; explicit close() uses "closed".
          this.host.setState("failed");
        }, CONSENT_TIMEOUT * 1000);
      };

      onCancel.once(() => {
        canceled = true;
        // Avoid clearing a replacement session's timer/handle.
        if (sessionId === this.sessionId) {
          clearConsentExpiry();
          this.requestAbort?.abort();
          this.requestAbort = undefined;
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

      try {
        while (
          !isTerminalState() &&
          !canceled &&
          sessionId === this.sessionId
        ) {
          await this.abortableDelay(
            Math.max(0, nextConsentAt - Date.now()),
            cancelEvent.signal,
          );

          if (canceled || isTerminalState() || sessionId !== this.sessionId) {
            break;
          }

          // Fix next start time before awaiting any response (independent timers).
          nextConsentAt = Date.now() + randomizedConsentInterval();

          const nominated = this.host.selected();
          if (!nominated) {
            break;
          }

          const pairId = nominated.id;
          const generation = this.host.remoteGeneration();
          const localGeneration = this.host.generation();
          const remotePassword = this.host.remotePassword();

          const request = this.host.buildRequest(nominated);
          if (!this.host.decorateRequest(request, nominated)) {
            continue;
          }

          this.requestAbort?.abort();
          const requestAbort = new AbortController();
          this.requestAbort = requestAbort;

          nominated.consentRequestsSent++;
          nominated.requestsSent++;

          // RTT-aware wait (floor 500ms); independent of retransmissions: 0.
          const responseTimeout = consentResponseTimeoutMs(nominated.rtt);
          const requestStartedAt = performance.now();

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
            .then(async ([response, addr]) => {
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
                this.host.generation() !== localGeneration ||
                this.host.remoteGeneration() !== generation
              ) {
                return;
              }
              if (this.host.remotePassword() !== remotePassword) {
                return;
              }

              const rtt = (performance.now() - requestStartedAt) / 1000; // seconds
              nominated.rtt = rtt;
              nominated.totalRoundTripTime += rtt;
              nominated.roundTripTimeMeasurements++;

              nominated.responsesReceived++;
              this.fresh = true;
              refreshConsentExpiry();
              if (state === "disconnected") {
                this.host.setState("connected");
              }
              await this.host.onResponse(
                response,
                addr,
                nominated,
                localGeneration,
              );
            })
            .catch((error) => {
              // Individual request loss is expected; keep monitoring (RFC 7675).
              if (
                sessionId === this.sessionId &&
                this.host.selected()?.id === pairId
              ) {
                log("no stun response", error);
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
