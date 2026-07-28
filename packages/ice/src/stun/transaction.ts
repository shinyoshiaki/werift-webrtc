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
  return {
    retransmissions: retransmissionsOrOptions,
    onRequestSent,
  };
}

export class Transaction {
  private timeoutDelay: number;
  ended = false;
  private tries = 0;
  private readonly triesMax: number;
  private readonly onResponse = new Event<[Message, Address]>();
  private readonly onRequestSent?: (attempt: number) => void;
  private readonly signal?: AbortSignal;
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
  }

  responseReceived = (message: Message, addr: Address) => {
    if (this.onResponse.length > 0) {
      if (message.messageClass === classes.RESPONSE) {
        this.onResponse.execute(message, addr);
        this.onResponse.complete();
      } else {
        this.onResponse.error(new TransactionFailed(message, addr));
      }
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
