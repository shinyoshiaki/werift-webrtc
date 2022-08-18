import { Message } from "./stun/message";
import { Address } from "./types/model";

export class TransactionError extends Error {
  response?: Message;
  addr?: Address;
}

export class TransactionFailed extends TransactionError {
  constructor(public response: Message, public addr: Address) {
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
