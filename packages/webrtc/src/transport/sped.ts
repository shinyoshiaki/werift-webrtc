import type { CandidatePair, Connection } from "../../../ice/src";
import {
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
  isAuthenticatedHandshakePair,
} from "../../../ice/src/internal/datagram";
import type { SpedRuntime } from "../../../ice/src/sped/runtime";
import {
  type Address,
  type DatagramRxMeta,
  type Transport,
  debug,
} from "../imports/common";
import { isDtls } from "../utils";

const log = debug("werift:packages/webrtc/src/transport/sped.ts");

const EARLY_SEND_MAX_PACKETS = 256;
const EARLY_SEND_MAX_BYTES = 256 * 1024;
const EARLY_SEND_RETENTION_MS = 2_000;
const EARLY_SEND_RETRY_MS = 10;

type PendingEarlySend = {
  data: Buffer;
  addr?: Address;
  generation: number;
  expiresAt?: number;
  early: boolean;
  application: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
};

/**
 * ICE Transport for SPED: handshake send is suppressed while embedding,
 * then uses the authenticated CandidatePair (pre-nomination handshake only).
 * After DTLS is up, application records always use Connection.send().
 */
export class IceSpedTransport implements Transport {
  closed = false;
  readonly peerAuthenticated = true;
  type = "ice-sped";
  private runtime?: SpedRuntime;
  private readonly datagramSubscription: { unSubscribe(): void };
  private readonly stateSubscription?: { unSubscribe(): void };
  private pendingEarlySends: PendingEarlySend[] = [];
  private pendingEarlySendBytes = 0;
  private earlySendExpiryTimer?: ReturnType<typeof setTimeout>;
  private earlySendRetryTimer?: ReturnType<typeof setTimeout>;
  private earlySendFlushInProgress = false;
  /** Policy gate for application records queued before DTLS authentication. */
  private earlyApplicationSendEnabled = true;
  /**
   * True after the first DTLS handshake completes. ICE restart after
   * DTLS is connected marks SPED complete so application records stay
   * on the nominated path.
   */
  private applicationReady = false;
  /** DTLS 1.3 application write key exists; peer auth may still be pending. */
  private applicationWriteReady = false;

  constructor(private readonly ice: Connection) {
    this.datagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => {
        if (
          ctx.generation === ice.generation &&
          ctx.pair &&
          ctx.authenticated &&
          isAuthenticatedHandshakePair(ctx.pair)
        ) {
          // Binding/Data の受信で pair が認証済みになった場合、保留中の
          // early application record を同じ世代の wire path へ送る。
          this.flushPendingEarlySends();
        }
        if (!isDtls(ctx.bytes) || !this.onData) {
          return;
        }
        if (!allowsAuthenticatedDtlsDelivery(ctx, ice.generation)) {
          return;
        }
        if (this.applicationReady && ctx.pair !== ice.nominated) {
          return;
        }
        // 世代トークンを engine RX queue まで運び、restart 後の stale 実行を防ぐ。
        this.onData(ctx.bytes, ctx.source, { rxGeneration: ctx.generation });
      },
    );
    const stateChanged = (
      ice as unknown as {
        stateChanged?: {
          subscribe(execute: (state: string) => void): { unSubscribe(): void };
        };
      }
    ).stateChanged;
    this.stateSubscription = stateChanged?.subscribe((state) => {
      if (state === "failed" || state === "closed") {
        this.rejectPendingEarlySends(
          new Error(`ICE ${state} before SPED application path was ready`),
        );
        return;
      }
      this.flushPendingEarlySends();
    });
  }

  setRuntime(runtime: SpedRuntime) {
    this.runtime = runtime;
    this.flushPendingEarlySends();
  }

  markApplicationReady() {
    this.applicationReady = true;
    this.applicationWriteReady = true;
    this.flushPendingEarlySends();
  }

  markApplicationWriteReady() {
    this.applicationWriteReady = true;
    this.flushPendingEarlySends();
  }

  /**
   * Revoke only queued early application/media records. DTLS handshake and
   * alert records remain in the queue because they are control traffic needed
   * to complete or tear down the association.
   */
  setEarlyApplicationSendEnabled(enabled: boolean): void {
    if (this.earlyApplicationSendEnabled === enabled) return;
    this.earlyApplicationSendEnabled = enabled;
    if (!enabled) {
      this.rejectPendingEarlySends(
        new Error("SPED early application send permission revoked"),
        (item) => item.early && item.application,
      );
      return;
    }
    this.flushPendingEarlySends();
  }

  onData: (buf: Buffer, addr?: Address, meta?: DatagramRxMeta) => void =
    () => {};

  /**
   * Writable so DtlsClient.associationInject can pin the authenticated STUN
   * source. Falls back to nominated / last SPED path when unset.
   */
  private rinfoPin?: { address: string; port: number };

  get address() {
    const [address, port] = this.remotePeer();
    return { address, port, family: address.includes(":") ? "IPv6" : "IPv4" };
  }

  get rinfo() {
    if (this.rinfoPin) {
      return this.rinfoPin;
    }
    const [address, port] = this.remotePeer();
    return { address, port };
  }

  set rinfo(value: { address?: string; port?: number } | undefined) {
    if (value?.address != null && value.port != null) {
      this.rinfoPin = { address: value.address, port: value.port };
    }
  }

  readonly send = async (data: Buffer, addr?: Address) => {
    await this.sendInternal(data, addr, isDtlsApplicationData(data), false);
  };

  /** Explicit application marker for encrypted DTLS 1.3 records. */
  readonly sendApplication = async (data: Buffer, addr?: Address) => {
    await this.sendInternal(data, addr, true, false);
  };

  private async sendInternal(
    data: Buffer,
    addr: Address | undefined,
    application: boolean,
    waitForWire: boolean,
  ) {
    this.assertIceSendable();
    if (this.applicationReady) {
      if (!this.ice.canSendApplicationData()) {
        // DTLS/SCTP の送信元は ICE nomination と同じ受信処理から再開する
        // ことがあるため、ここで await すると nomination 自体を止めてしまう。
        // wire 送信は path が利用可能になった後に flush し、呼び出し元には
        // 受理済みとして直ちに返す。ただし経路喪失時に無期限保持しない。
        const pending = this.enqueueEarlySend(data, addr, {
          early: false,
          application,
        });
        if (waitForWire) {
          await pending;
        } else {
          void pending.catch((error) => {
            log("failed to queue application data", error);
          });
        }
        return;
      }
      await this.ice.send(data);
      return;
    }
    if (this.applicationWriteReady) {
      if (application && !this.earlyApplicationSendEnabled) {
        throw new Error("SPED early application send permission revoked");
      }
      const nominated = this.ice.nominated;
      const pair =
        this.resolveAuthenticatedSendPair(addr) ??
        (nominated && this.isCurrentAuthenticatedPair(nominated)
          ? nominated
          : undefined);
      if (!pair) {
        await this.enqueueEarlySend(data, addr, {
          early: true,
          application,
        });
        return;
      }
      this.runtime?.pinHandshakePath(pair);
      await pair.protocol.sendData(data, pair.remoteAddr);
      return;
    }
    if (this.runtime?.session.embedding) {
      return;
    }
    if (this.ice.nominated) {
      await this.ice.send(data);
      return;
    }
    const pair = this.resolveAuthenticatedSendPair(addr);
    if (!pair) {
      return;
    }
    this.runtime?.pinHandshakePath(pair);
    await pair.protocol.sendData(data, pair.remoteAddr);
  }

  /**
   * Wait for an application/media record to reach the wire. Generic DTLS
   * sends must remain non-blocking while ICE is still nominating because the
   * nomination check can be completed by the same inbound DTLS/STUN turn.
   */
  readonly sendAndWait = async (data: Buffer, addr?: Address) => {
    // sendAndWait is used by SRTP/SRTCP and therefore always represents
    // application/media traffic, even though its bytes are not a DTLS record.
    await this.sendInternal(data, addr, true, true);
  };

  async close() {
    this.closed = true;
    this.datagramSubscription.unSubscribe();
    this.stateSubscription?.unSubscribe();
    this.rejectPendingEarlySends(new Error("SPED transport is closed"));
  }

  private async enqueueEarlySend(
    data: Buffer,
    addr?: Address,
    options: { early: boolean; application: boolean } = {
      early: true,
      application: true,
    },
    retentionMs = EARLY_SEND_RETENTION_MS,
  ) {
    if (this.closed) {
      throw new Error("SPED transport is closed");
    }
    if (this.ice.state === "failed" || this.ice.state === "closed") {
      throw new Error(
        `ICE ${this.ice.state} before SPED application path was ready`,
      );
    }
    if (
      options.early &&
      options.application &&
      !this.earlyApplicationSendEnabled
    ) {
      throw new Error("SPED early application send permission revoked");
    }
    if (
      this.pendingEarlySends.length >= EARLY_SEND_MAX_PACKETS ||
      this.pendingEarlySendBytes + data.length > EARLY_SEND_MAX_BYTES
    ) {
      throw new Error("SPED early application send queue is full");
    }

    const pending = new Promise<void>((resolve, reject) => {
      this.pendingEarlySends.push({
        data: Buffer.from(data),
        addr,
        generation: this.ice.generation,
        expiresAt: Date.now() + retentionMs,
        early: options.early,
        application: options.application,
        resolve,
        reject: (error) => reject(error),
      });
      this.pendingEarlySendBytes += data.length;
    });
    this.scheduleEarlySendExpiry();
    this.scheduleEarlySendRetry();
    return pending;
  }

  private assertIceSendable() {
    if (this.ice.state === "failed" || this.ice.state === "closed") {
      throw new Error(`ICE ${this.ice.state} cannot send SPED data`);
    }
  }

  private scheduleEarlySendExpiry() {
    if (this.earlySendExpiryTimer || this.pendingEarlySends.length === 0) {
      return;
    }
    const expiresAt = this.pendingEarlySends.reduce<number | undefined>(
      (earliest, item) =>
        item.expiresAt === undefined
          ? earliest
          : earliest === undefined
            ? item.expiresAt
            : Math.min(earliest, item.expiresAt),
      undefined,
    );
    if (expiresAt === undefined) {
      return;
    }
    this.earlySendExpiryTimer = setTimeout(
      () => {
        this.earlySendExpiryTimer = undefined;
        if (
          this.pendingEarlySends.some(
            (item) =>
              item.expiresAt !== undefined && item.expiresAt <= Date.now(),
          )
        ) {
          this.rejectPendingEarlySends(
            new Error(
              "SPED early application send timed out waiting for an authenticated candidate pair",
            ),
          );
        } else {
          this.scheduleEarlySendExpiry();
        }
      },
      Math.max(0, expiresAt - Date.now()),
    );
  }

  private scheduleEarlySendRetry() {
    if (
      this.closed ||
      this.earlySendRetryTimer ||
      this.pendingEarlySends.length === 0
    ) {
      return;
    }
    this.earlySendRetryTimer = setTimeout(() => {
      this.earlySendRetryTimer = undefined;
      this.flushPendingEarlySends();
    }, EARLY_SEND_RETRY_MS);
  }

  private clearEarlySendTimers() {
    if (this.earlySendExpiryTimer) {
      clearTimeout(this.earlySendExpiryTimer);
      this.earlySendExpiryTimer = undefined;
    }
    if (this.earlySendRetryTimer) {
      clearTimeout(this.earlySendRetryTimer);
      this.earlySendRetryTimer = undefined;
    }
  }

  private rejectPendingEarlySends(
    error: Error,
    shouldReject: (item: PendingEarlySend) => boolean = () => true,
  ) {
    const retained: PendingEarlySend[] = [];
    for (const item of this.pendingEarlySends) {
      if (shouldReject(item)) {
        item.reject(error);
      } else {
        retained.push(item);
      }
    }
    this.pendingEarlySends = retained;
    this.pendingEarlySendBytes = retained.reduce(
      (bytes, item) => bytes + item.data.length,
      0,
    );
    if (retained.length === 0) {
      this.clearEarlySendTimers();
    } else if (!this.earlySendFlushInProgress) {
      this.scheduleEarlySendExpiry();
      this.scheduleEarlySendRetry();
    }
  }

  private flushPendingEarlySends() {
    if (
      this.closed ||
      this.earlySendFlushInProgress ||
      this.pendingEarlySends.length === 0
    ) {
      return;
    }
    this.earlySendFlushInProgress = true;
    void (async () => {
      while (!this.closed && this.pendingEarlySends.length > 0) {
        if (this.ice.state === "failed" || this.ice.state === "closed") {
          this.rejectPendingEarlySends(
            new Error(
              `ICE ${this.ice.state} before SPED application path was ready`,
            ),
          );
          return;
        }
        const item = this.pendingEarlySends[0]!;
        if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
          // Timer execution can be delayed by a busy event loop.  Expiration
          // is a send-time invariant, not merely a timer-side statistic.
          this.rejectPendingEarlySends(
            new Error("SPED early application send timed out"),
          );
          return;
        }
        if (
          item.early &&
          item.application &&
          !this.earlyApplicationSendEnabled
        ) {
          this.rejectPendingEarlySends(
            new Error("SPED early application send permission revoked"),
            (candidate) => candidate.early && candidate.application,
          );
          continue;
        }
        if (item.generation !== this.ice.generation) {
          this.pendingEarlySends.shift();
          this.pendingEarlySendBytes -= item.data.length;
          item.reject(new Error("SPED early application send became stale"));
          continue;
        }

        const pair = this.applicationReady
          ? undefined
          : this.resolveAuthenticatedSendPair(item.addr);
        if (this.applicationReady && !this.ice.canSendApplicationData()) {
          this.scheduleEarlySendRetry();
          return;
        }
        if (!this.applicationReady && !pair) {
          this.scheduleEarlySendRetry();
          return;
        }

        // Re-check immediately before the wire call after pair resolution;
        // policy and retention may have changed while resolving the path.
        if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
          this.rejectPendingEarlySends(
            new Error("SPED early application send timed out"),
          );
          return;
        }
        if (
          item.early &&
          item.application &&
          !this.earlyApplicationSendEnabled
        ) {
          this.rejectPendingEarlySends(
            new Error("SPED early application send permission revoked"),
            (candidate) => candidate.early && candidate.application,
          );
          continue;
        }

        try {
          if (this.applicationReady) {
            await this.ice.send(item.data);
          } else {
            this.runtime?.pinHandshakePath(pair!);
            await pair!.protocol.sendData(item.data, pair!.remoteAddr);
          }
          if (this.pendingEarlySends[0] !== item) {
            // close() / restart が待機項目を先に破棄した場合は、解決を再発火しない。
            return;
          }
          this.pendingEarlySends.shift();
          this.pendingEarlySendBytes -= item.data.length;
          item.resolve();
        } catch (error) {
          if (this.pendingEarlySends[0] !== item) {
            return;
          }
          this.pendingEarlySends.shift();
          this.pendingEarlySendBytes -= item.data.length;
          item.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    })().finally(() => {
      this.earlySendFlushInProgress = false;
      if (this.pendingEarlySends.length === 0) {
        this.clearEarlySendTimers();
      } else {
        this.scheduleEarlySendRetry();
      }
    });
  }

  /**
   * Match the carrier dest to an authenticated current-generation pair.
   * A pinned lastPath must not be abandoned for a later candidate.
   */
  private resolveAuthenticatedSendPair(
    addr?: Address,
  ): CandidatePair | undefined {
    const pinned = this.runtime?.lastPath;
    if (pinned && this.isCurrentAuthenticatedPair(pinned)) {
      if (!addr) {
        return pinned;
      }
      if (
        pinned.remoteAddr[0] === addr[0] &&
        pinned.remoteAddr[1] === addr[1]
      ) {
        return pinned;
      }
      return undefined;
    }
    // An existing association pin is an ownership boundary.  Wait for that
    // same pair to become authenticated instead of switching an early record
    // to an unrelated candidate merely because it became available first.
    if (pinned && !addr) {
      return undefined;
    }
    if (!addr) {
      const nominated = this.ice.nominated;
      if (nominated && this.isCurrentAuthenticatedPair(nominated)) {
        return nominated;
      }
      return (this.ice.checkList ?? []).find((pair) =>
        this.isCurrentAuthenticatedPair(pair),
      );
    }
    const list = this.ice.checkList ?? [];
    return list.find(
      (pair) =>
        pair.remoteAddr[0] === addr[0] &&
        pair.remoteAddr[1] === addr[1] &&
        this.isCurrentAuthenticatedPair(pair),
    );
  }

  private isCurrentAuthenticatedPair(pair: CandidatePair): boolean {
    const list = this.ice.checkList ?? [];
    if (!list.includes(pair) && this.ice.nominated !== pair) {
      return false;
    }
    return isAuthenticatedHandshakePair(pair);
  }

  private remotePeer(): Address {
    const nominated = this.ice.nominated;
    if (nominated) {
      return nominated.remoteAddr;
    }
    const path = this.runtime?.lastPath;
    if (path) {
      return path.remoteAddr;
    }
    return ["0.0.0.0", 0];
  }
}

function isDtlsApplicationData(data: Buffer): boolean {
  // DTLS record ContentType.application_data.  Raw SRTP/SRTCP is classified
  // explicitly by sendAndWait(), so handshake/control records are preserved.
  return data[0] === 23;
}
