import debug from "debug";
import { Event } from "rx.mini";
import { TransactionFailed, TransactionTimeout } from "../exceptions";
import { Address, Protocol } from "../types/model";
import { classes, RETRY_MAX, RETRY_RTO } from "./const";
import { Message } from "./message";

const log = debug("werift/ice/stun/transaction");

export class Transaction {
  integrityKey?: Buffer;
  private timeoutDelay = RETRY_RTO;
  private timeoutHandle?: any;
  private tries = 0;
  private readonly triesMax =
    1 + (this.retransmissions ? this.retransmissions : RETRY_MAX);
  private readonly onResponse = new Event<[Message, Address]>();

  constructor(
    private request: Message,
    private addr: Address,
    private protocol: Protocol,
    private retransmissions?: number
  ) {}

  responseReceived = (message: Message, addr: Address) => {
    if (this.onResponse.length > 0) {
      if (message.messageClass === classes.RESPONSE) {
        this.onResponse.execute(message, addr);
        this.onResponse.complete();
      } else {
        this.onResponse.error(new TransactionFailed(message));
      }
    }
  };

  run = async () => {
    try {
      this.retry();
      return await this.onResponse.asPromise();
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
      }
    }
  };

  private retry = () => {
    if (this.tries >= this.triesMax) {
      log("retry failed", this.tries);
      this.onResponse.error(new TransactionTimeout());
      return;
    }
    this.protocol.sendStun(this.request, this.addr);
    this.timeoutHandle = setTimeout(this.retry, this.timeoutDelay);
    this.timeoutDelay *= 2;
    this.tries++;
  };

  cancel() {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
  }
}
