import { Event } from "../imports/common";
import type { DtlsState, WebRtcDtlsReadiness } from "./dtls-types";

/** @internal What a readiness waiter needs to know about its transport. */
export interface ReadinessWaitContext {
  /** Fires when a new attempt becomes current (a waiter may be satisfied). */
  readonly onAttemptChanged: Event<[]>;
  readonly onStateChange: Event<[DtlsState]>;
  /** The transport is closed or failed. */
  isTerminated(): boolean;
  /** Error that terminated the transport, if any. */
  lastError(): Error | undefined;
}

type Milestone = keyof WebRtcDtlsReadiness;

/**
 * @internal WebRTC-level readiness of an {@link RTCDtlsTransport}, which adds
 * SDP fingerprint authentication (`peerAuthenticated`) on top of the DTLS
 * socket's own readiness, plus the handshake timing used by stats.
 *
 * `writeReady` is per attempt (an ICE restart of an in-flight handshake
 * resets it); `peerAuthenticated` is revoked only when the remote description
 * no longer matches the certificate; `handshakeComplete` is a latch.
 */
export class TransportReadiness {
  readonly onWriteReady = new Event<[]>();
  readonly onPeerAuthenticated = new Event<[]>();
  readonly onHandshakeComplete = new Event<[]>();
  /** Start of the current handshake attempt (ms since epoch). */
  handshakeStartedAt?: number;
  /** When the peer's certificate matched the SDP fingerprint (ms since epoch). */
  peerAuthenticatedAt?: number;
  private readonly reached: WebRtcDtlsReadiness = {
    writeReady: false,
    peerAuthenticated: false,
    handshakeComplete: false,
  };
  private readonly context: ReadinessWaitContext;

  constructor(context: ReadinessWaitContext) {
    this.context = context;
  }

  get writeReady() {
    return this.reached.writeReady;
  }

  get peerAuthenticated() {
    return this.reached.peerAuthenticated;
  }

  get handshakeComplete() {
    return this.reached.handshakeComplete;
  }

  /** Copy of the three milestones (diagnostics and tests). */
  snapshot(): WebRtcDtlsReadiness {
    return { ...this.reached };
  }

  /** A handshake attempt starts now. */
  startHandshake(now = Date.now()): void {
    this.handshakeStartedAt = now;
  }

  /**
   * An ICE restart replaced the in-flight attempt: the new attempt has no
   * write key of its own yet and is timed from now. Peer authentication of
   * the association is kept.
   */
  restartAttempt(now = Date.now()): void {
    this.reached.writeReady = false;
    this.handshakeStartedAt = now;
    this.peerAuthenticatedAt = undefined;
  }

  /**
   * Reach `writeReady`. `beforeNotify` runs with the milestone already set,
   * before waiters are released. Returns false when it was already reached.
   */
  reachWriteReady(beforeNotify?: () => void): boolean {
    if (this.reached.writeReady) return false;
    this.reached.writeReady = true;
    beforeNotify?.();
    this.onWriteReady.execute();
    return true;
  }

  /**
   * The peer's certificate matched the SDP fingerprint. Waiters are released
   * later by {@link announcePeerAuthenticated}, once the transport connected.
   */
  authenticatePeer(now = Date.now()): void {
    this.reached.peerAuthenticated = true;
    this.peerAuthenticatedAt = now;
  }

  announcePeerAuthenticated(): void {
    this.onPeerAuthenticated.execute();
  }

  /** A new remote description no longer matches the association's certificate. */
  revokePeerAuthentication(): void {
    this.reached.peerAuthenticated = false;
    this.peerAuthenticatedAt = undefined;
  }

  /** Reach the `handshakeComplete` latch. Returns false when already reached. */
  reachHandshakeComplete(): boolean {
    if (this.reached.handshakeComplete) return false;
    this.reached.handshakeComplete = true;
    this.onHandshakeComplete.execute();
    return true;
  }

  /**
   * Resolve once `milestone` is reached, also when an attempt change or the
   * milestone event finds it reached; reject when the transport closes or
   * fails first.
   */
  waitFor(milestone: Milestone): Promise<void> {
    if (this.reached[milestone]) return Promise.resolve();
    const closedError = () =>
      this.context.lastError() ??
      new Error(
        milestone === "writeReady"
          ? "DTLS transport closed before write readiness"
          : "DTLS transport closed before readiness",
      );
    if (this.context.isTerminated()) return Promise.reject(closedError());
    const event = {
      writeReady: this.onWriteReady,
      peerAuthenticated: this.onPeerAuthenticated,
      handshakeComplete: this.onHandshakeComplete,
    }[milestone];
    return new Promise<void>((resolve, reject) => {
      const resolveIfReached = () => {
        if (!this.reached[milestone]) return;
        cleanup();
        resolve();
      };
      const ready = event.subscribe(resolveIfReached);
      const attempt = this.context.onAttemptChanged.subscribe(resolveIfReached);
      const state = this.context.onStateChange.subscribe((next) => {
        if (next !== "failed" && next !== "closed") return;
        cleanup();
        reject(closedError());
      });
      const cleanup = () => {
        ready.unSubscribe();
        attempt.unSubscribe();
        state.unSubscribe();
      };
      resolveIfReached();
    });
  }
}
