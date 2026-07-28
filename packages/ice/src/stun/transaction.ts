import { type Address, Event, debug } from "../imports/common";

import { TransactionFailed, TransactionTimeout } from "../exceptions";
import type { Protocol, TransactionRequestOptions } from "../types/model";
import { RETRY_MAX, RETRY_RTO, classes } from "./const";
import type { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

/**
 * Normalize legacy positional args and the options-object form into one shape.
 * Existing callers pass `(retransmissions?, onRequestSent?)`.
 */
export function normalizeTransactionOptions(
  retransmissionsOrOptions?: number | TransactionRequestOptions,
  onRequestSent?: (attempt: number) => void,
): TransactionRequestOptions {
  if (
    retransmissionsOrOptions !== null &&
    typeof retransmissionsOrOptions === "object"
  ) {
    return retransmissionsOrOptions;
  }
  // After the object branch, only number | undefined remains (legacy positional API).
  const retransmissions =
    typeof retransmissionsOrOptions === "number"
      ? retransmissionsOrOptions
      : undefined;
  return {
    retransmissions,
    onRequestSent,
  };
}

/** Compare ICE transport addresses (host, port). */
export function addressEquals(a: Address, b: Address): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export class Transaction {
  private timeoutDelay: number;
  ended = false;
  private tries = 0;
  private readonly triesMax: number;
  private readonly onResponse = new Event<[Message, Address]>();
  private readonly onRequestSent?: (attempt: number) => void;
  private readonly signal?: AbortSignal;
  /** Remote address this transaction was sent to; responses must match. */
  readonly expectedAddr: Address;
  /**
   * When set, protocol layers re-parse the wire response with this key so
   * MESSAGE-INTEGRITY failures are rejected before responseReceived.
   */
  readonly integrityKey?: Buffer;
  private waitTimer?: ReturnType<typeof setTimeout>;
  private waitResolve?: () => void;
  private onAbort?: () => void;

  constructor(
    private request: Message,
    private addr: Address,
    private protocol: Protocol,
    retransmissionsOrOptions?: number | TransactionRequestOptions,
    onRequestSent?: (attempt: number) => void,
  ) {
    const options = normalizeTransactionOptions(
      retransmissionsOrOptions,
      onRequestSent,
    );
    // triesMax = initial send + retransmissions
    this.triesMax = 1 + (options.retransmissions ?? RETRY_MAX);
    // responseTimeout is independent of retransmission count (RFC 7675 / 8445)
    this.timeoutDelay = options.responseTimeout ?? RETRY_RTO;
    this.onRequestSent = options.onRequestSent;
    this.signal = options.signal;
    this.expectedAddr = addr;
    this.integrityKey = options.integrityKey;
  }

  /**
   * Accept a matching authenticated non-error response from the expected
   * remote address. Wrong address or non-success class is rejected without
   * completing the transaction (wrong address is ignored so we keep waiting).
   */
  responseReceived = (message: Message, addr: Address) => {
    if (this.ended || this.onResponse.length === 0) {
      return;
    }

    // RFC 7675 / ICE: only responses from the request's transport address.
    if (!addressEquals(this.expectedAddr, addr)) {
      log(
        "ignore STUN response from unexpected address",
        addr,
        "expected",
        this.expectedAddr,
      );
      return;
    }

    if (message.messageClass === classes.RESPONSE) {
      this.onResponse.execute(message, addr);
      this.onResponse.complete();
    } else {
      // ERROR class or other non-success
      this.onResponse.error(new TransactionFailed(message, addr));
    }
  };

  run = async () => {
    try {
      if (this.signal?.aborted) {
        throw new TransactionTimeout();
      }
      this.attachAbortListener();
      this.retry().catch((e) => {
        log("retry failed", e);
      });
      const res = await this.onResponse.asPromise();
      return res;
    } catch (error) {
      throw error;
    } finally {
      this.cancel();
    }
  };

  private attachAbortListener() {
    if (!this.signal) {
      return;
    }
    this.onAbort = () => {
      this.failWithTimeout();
    };
    this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  private failWithTimeout() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.clearWait();
    if (this.onResponse.length > 0) {
      this.onResponse.error(new TransactionTimeout());
    }
  }

  private clearWait() {
    if (this.waitTimer !== undefined) {
      clearTimeout(this.waitTimer);
      this.waitTimer = undefined;
    }
    const resolve = this.waitResolve;
    this.waitResolve = undefined;
    resolve?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.ended || this.signal?.aborted) {
        resolve();
        return;
      }
      this.waitResolve = resolve;
      this.waitTimer = setTimeout(() => {
        this.waitTimer = undefined;
        this.waitResolve = undefined;
        resolve();
      }, ms);
    });
  }

  private retry = async () => {
    while (this.tries < this.triesMax && !this.ended) {
      this.onRequestSent?.(this.tries);
      this.protocol.sendStun(this.request, this.addr).catch((e) => {
        log("send stun failed", e);
      });
      await this.wait(this.timeoutDelay);
      if (this.ended) {
        break;
      }
      this.timeoutDelay *= 2;
      this.tries++;
    }
    if (this.tries >= this.triesMax && !this.ended) {
      log(`retry failed times:${this.tries} maxLimit:${this.triesMax}`);
      this.failWithTimeout();
    }
  };

  cancel() {
    this.ended = true;
    this.clearWait();
    if (this.signal && this.onAbort) {
      this.signal.removeEventListener("abort", this.onAbort);
      this.onAbort = undefined;
    }
  }
}

/**
 * Build Transaction options for Protocol.request, folding integrityKey into
 * options so response path can re-verify MESSAGE-INTEGRITY.
 */
export function buildTransactionOptions(
  integrityKey: Buffer | undefined,
  retransmissionsOrOptions?: number | TransactionRequestOptions,
  onRequestSent?: (attempt: number) => void,
): TransactionRequestOptions {
  const options = normalizeTransactionOptions(
    retransmissionsOrOptions,
    onRequestSent,
  );
  if (integrityKey && !options.integrityKey) {
    options.integrityKey = integrityKey;
  }
  return options;
}
