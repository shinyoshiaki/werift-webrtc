import type { Address } from "./imports/common";
import type { Message } from "./stun/message";

export class TransactionError extends Error {
  response?: Message;
  addr?: Address;
}

export class TransactionFailed extends TransactionError {
  public response: Message;
  public addr: Address;

  constructor(response: Message, addr: Address) {
    super();
    this.response = response;
    this.addr = addr;
  }

  get str() {
    let out = "STUN transaction failed";
    const attribute = this.response.getAttributeValue("ERROR-CODE");
    if (attribute) {
      const [code, msg] = attribute;
      out += ` (${code} - ${msg})`;
    }
    return out;
  }
}

export class TransactionTimeout extends TransactionError {
  get str() {
    return "STUN transaction timed out";
  }
}

/** The protocol carrying the transaction closed before a response arrived. */
export class TransactionCancelled extends TransactionError {
  get str() {
    return "STUN transaction cancelled";
  }
}

/**
 * The request target is an IP literal of a different family than the socket
 * that would carry it, so it can never be delivered.
 */
export class AddressFamilyMismatch extends Error {
  public addr: Address;
  public socketFamily: 4 | 6;

  constructor(addr: Address, socketFamily: 4 | 6) {
    super(
      `cannot reach ${addr[0]}:${addr[1]} from an IPv${socketFamily} socket`,
    );
    this.addr = addr;
    this.socketFamily = socketFamily;
  }
}

export type TurnRedirectFailureReason =
  /** 300 (Try Alternate) without an ALTERNATE-SERVER attribute. */
  | "missing-alternate"
  /** ALTERNATE-SERVER names a server already tried for this Allocate. */
  | "loop"
  /** More redirects than the client follows for one Allocate. */
  | "too-many-redirects"
  /** A stream (TCP/TLS) transport that cannot reconnect to the alternate. */
  | "unsupported-transport";

/**
 * A TURN Allocate was answered with 300 (Try Alternate) and the redirect
 * could not be followed (RFC 8656 §7.4, RFC 8489 §10). The 300 response is
 * kept as `cause`.
 */
export class TurnRedirectError extends Error {
  public reason: TurnRedirectFailureReason;
  /** Server that answered 300. */
  public server: Address;
  /** ALTERNATE-SERVER of the 300 response, when present. */
  public alternate: Address | undefined;

  constructor(
    reason: TurnRedirectFailureReason,
    server: Address,
    alternate: Address | undefined,
    cause: TransactionFailed,
  ) {
    super(
      `TURN Allocate to ${server[0]}:${server[1]} returned 300 (Try Alternate)` +
        (alternate ? ` to ${alternate[0]}:${alternate[1]}` : "") +
        `; redirect not followed: ${reason}`,
      { cause },
    );
    this.reason = reason;
    this.server = server;
    this.alternate = alternate;
  }
}
