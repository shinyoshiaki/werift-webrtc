import { promises as dns } from "node:dns";
import { isIP } from "node:net";

import { type Address, Event, debug } from "../imports/common";

import { TransactionFailed, TransactionTimeout } from "../exceptions";
import type { Protocol, TransactionRequestOptions } from "../types/model";
import { RETRY_MAX, RETRY_RTO, classes } from "./const";
import type { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

/**
 * Resolve a request target to a concrete IP before creating a Transaction so
 * response source-address checks match the UDP peer address (hostname ≠ IP).
 */
export async function resolveRequestAddress(
  addr: Address,
  family: 0 | 4 | 6 = 0,
): Promise<Address> {
  if (isIP(addr[0])) {
    return addr;
  }
  const looked = await dns.lookup(addr[0], { family });
  return [looked.address, addr[1]];
}

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

  /** First-send snapshot so STUN retransmits do not re-run SPED round-robin. */
  private readonly requestBytes: Buffer;

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
    this.requestBytes = Buffer.from(request.bytes);
    Object.defineProperty(request, "bytes", {
      configurable: true,
      enumerable: false,
      get: () => this.requestBytes,
    });
  }

  /**
   * Accept a matching authenticated non-error response from the expected
   * remote address. Wrong address, missing MESSAGE-INTEGRITY (when required),
   * or non-success class is rejected without completing the transaction
   * (wrong address / unauthenticated responses are ignored so we keep waiting).
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

    // RFC 7675 authenticated consent: integrityKey requires MESSAGE-INTEGRITY.
    // Wire HMAC is verified by protocol layers via parseMessage(data, key);
    // this presence check is defense-in-depth if responseReceived is called
    // with a constructed Message that skipped the wire re-parse path.
    if (this.integrityKey) {
      const hasIntegrity =
        message.attributesKeys.includes("MESSAGE-INTEGRITY") ||
        message.attributesKeys.includes("MESSAGE-INTEGRITY-SHA256");
      if (!hasIntegrity) {
        log(
          "ignore unauthenticated STUN response (MESSAGE-INTEGRITY required)",
        );
        return;
      }
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

  /** Fail an in-flight wait so ICE restart does not apply a stale response. */
  abandon() {
    this.failWithTimeout();
  }

  cancel() {
    this.ended = true;
    this.clearWait();
    if (this.signal && this.onAbort) {
      this.signal.removeEventListener("abort", this.onAbort);
      this.onAbort = undefined;
    }
    // Restore Message.bytes so TURN 401 retries can re-sign the same object.
    if (Object.prototype.hasOwnProperty.call(this.request, "bytes")) {
      // Instance defineProperty must be removed; assignment would shadow the getter.
      // biome-ignore lint/performance/noDelete: restore prototype Message.bytes getter
      delete (this.request as { bytes?: Buffer }).bytes;
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
