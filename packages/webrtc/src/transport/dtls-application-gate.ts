import { createPreAuthEarlyDataBuffer } from "../../../dtls/src/internal";

/** @internal Holds DTLS application data until the SDP fingerprint matches. */
export class InboundApplicationGate {
  private authenticated = false;
  private aborted = false;
  private buffer = createPreAuthEarlyDataBuffer();
  private retiredDroppedPackets = 0;
  private retiredDroppedBytes = 0;

  constructor(private readonly deliver: (data: Buffer) => void) {}

  /** Read-only snapshot source for stats; instance may rotate on restart. */
  snapshot() {
    const current = this.buffer.snapshot();
    return {
      ...current,
      droppedPackets: current.droppedPackets + this.retiredDroppedPackets,
      droppedBytes: current.droppedBytes + this.retiredDroppedBytes,
    };
  }

  receive(data: Buffer): void {
    if (this.aborted) return;
    if (this.authenticated) this.deliver(data);
    else this.buffer.push(data);
  }

  authenticate(
    shouldContinue?: () => boolean,
    isTerminal?: () => boolean,
  ): void {
    if (this.aborted || this.authenticated) return;
    if (shouldContinue && !shouldContinue()) {
      // restart による drift では新 attempt 用に gate を残し、terminal 時のみ廃棄する。
      if (isTerminal?.()) this.abort();
      return;
    }
    this.authenticated = true;
    const buffer = this.buffer;
    while (true) {
      // close/restart が deliver callback 内で発生したら残りを破棄する。
      if (this.aborted) {
        buffer.clear(true);
        return;
      }
      if (shouldContinue && !shouldContinue()) {
        if (isTerminal?.()) this.abort();
        else buffer.clear(true);
        return;
      }
      const data = buffer.takeOne();
      if (!data) return;
      this.deliver(data);
      if (this.aborted) {
        buffer.clear(true);
        return;
      }
      if (shouldContinue && !shouldContinue()) {
        if (isTerminal?.()) this.abort();
        else buffer.clear(true);
        return;
      }
    }
  }

  abort(): void {
    this.aborted = true;
    this.buffer.clear(true);
    this.buffer.dispose();
  }

  /**
   * ICE restart 後の新 attempt 用に gate を再初期化する。旧 drain の残余は
   * 呼び出し側が破棄済みとし、buffer と認証状態だけを新世代用に開き直す。
   * fingerprint mismatch 等の terminal abort とは別扱いである。
   */
  restartForNewAttempt(): void {
    // A generation change owns the old queue's complete lifecycle.  Dispose it
    // before replacing the instance so its retention timer cannot survive the
    // restart and mutate detached state two seconds later.
    this.buffer.clear(true);
    this.retainDroppedStats();
    this.buffer.dispose();
    this.authenticated = false;
    this.aborted = false;
    // dispose 済みの buffer は復活できないため新世代用に作り直す。
    this.buffer = createPreAuthEarlyDataBuffer();
  }

  /**
   * 未認証のまま保持している application data を drop 計上して捨てる。
   * SPED abort / direct fallback / 同一 generation の SPED reset はいずれも
   * 「現 attempt の pre-auth queue を無効化する」だけで、認証状態や gate の
   * 世代は変えない (世代切替は {@link restartForNewAttempt})。
   */
  discardPending(): void {
    if (!this.authenticated && !this.aborted) this.buffer.clear(true);
  }

  private retainDroppedStats(): void {
    const stats = this.buffer.snapshot();
    this.retiredDroppedPackets += stats.droppedPackets;
    this.retiredDroppedBytes += stats.droppedBytes;
  }
}
