import type { Address } from "./imports/common";
import type { Message } from "./stun/message";

export class TransactionError extends Error {
  response?: Message;
  addr?: Address;
}

export class TransactionFailed extends TransactionError {
  constructor(
    public response: Message,
    public addr: Address,
  ) {
    super();
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

/**
 * The request target is an IP literal of a different family than the socket
 * that would carry it, so it can never be delivered.
 */
export class AddressFamilyMismatch extends Error {
  constructor(
    public addr: Address,
    public socketFamily: 4 | 6,
  ) {
    super(
      `cannot reach ${addr[0]}:${addr[1]} from an IPv${socketFamily} socket`,
    );
  }
}
