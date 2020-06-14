import { Message } from "./stun/stun";

export class TransactionError extends Error {
  response?: Message;
}

export class TransactionFailed extends TransactionError {
  constructor(public response: Message) {
    super();
  }

  get str() {
    let out = "STUN transaction failed";
    if (Object.keys(this.response.attributes).includes("ERROR-CODE")) {
      const [code, msg] = this.response.attributes["ERROR-CODE"];
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
