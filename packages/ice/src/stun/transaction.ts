import { promises as dns } from "node:dns";
import { SocketAddress, isIP } from "node:net";

import { type Address, Event, debug } from "../imports/common";

import {
  AddressFamilyMismatch,
  TransactionFailed,
  TransactionTimeout,
} from "../exceptions";
import type { Protocol, TransactionRequestOptions } from "../types/model";
import { RETRY_MAX, RETRY_RTO, classes } from "./const";
import type { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

/**
 * Resolve a request target to a concrete IP before creating a Transaction so
 * response source-address checks match the UDP peer address (hostname ≠ IP).
 *
 * `family` is the family of the socket that will carry the request: a
 * hostname resolves only in that family, and an IP literal of the other
 * family throws AddressFamilyMismatch instead of retransmitting into a send
 * that cannot succeed. Family 0 means unknown: no preference, no check.
 */
export async function resolveRequestAddress(
  addr: Address,
  family: 0 | 4 | 6 = 0,
): Promise<Address> {
  const literalFamily = isIP(addr[0]);
  if (literalFamily) {
    if (family !== 0 && literalFamily !== family) {
      throw new AddressFamilyMismatch(addr, family);
    }
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

/**
 * Compare ICE transport addresses (host, port).
 * IPv6 literals are compared in canonical form because the socket reports
 * `::1` even when the peer was configured as `0:0:0:0:0:0:0:1`.
 */
export function addressEquals(a: Address, b: Address): boolean {
  return a[1] === b[1] && canonicalHost(a[0]) === canonicalHost(b[0]);
}

// Only used for comparison; never for the address a packet is sent to,
// since SocketAddress drops the zone id (`fe80::1%eth0`).
function canonicalHost(host: string): string {
  return isIP(host) === 6
    ? new SocketAddress({ address: host, family: "ipv6" }).address
    : host;
}

export class Transaction {
  private timeoutDelay: number;
  ended = false;
  private tries = 0;
  private readonly triesMax: number;
  private readonly onResponse = new Event<[Message, Address]>();
  private readonly onRequestSent?: (attempt: number) => void;
  private readonly signal?: AbortSignal;
  private readonly failOnSendError: boolean;
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
    this.failOnSendError = options.failOnSendError ?? false;
    this.expectedAddr = addr;
    this.integrityKey = options.integrityKey;
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
    this.fail(new TransactionTimeout());
  }

  private fail(error: Error) {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.clearWait();
    if (this.onResponse.length > 0) {
      this.onResponse.error(error);
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
        if (this.failOnSendError) {
          this.fail(e);
        }
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
