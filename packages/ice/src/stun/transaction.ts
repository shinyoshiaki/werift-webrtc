import { Event } from "rx.mini";
import { TransactionFailed, TransactionTimeout } from "../exceptions";
import { Address, Protocol } from "../typings/model";
import { classes, RETRY_MAX, RETRY_RTO } from "./const";
import { Message } from "./message";

export class Transaction {
  integrityKey?: Buffer;
  private timeoutDelay = RETRY_RTO;
  private timeoutHandle?: any;
  private tries = 0;
  private triesMax =
    1 + (this.retransmissions ? this.retransmissions : RETRY_MAX);
  private future = new Event<[Message, Address]>();

  constructor(
    private request: Message,
    private addr: Address,
    private protocol: Protocol,
    private retransmissions?: number
  ) {}

  responseReceived = (message: Message, addr: Address) => {
    if (this.future.length > 0) {
      if (message.messageClass === classes.RESPONSE) {
        this.future.execute(message, addr);
        this.future.complete();
      } else {
        this.future.error(new TransactionFailed(message));
      }
    }
  };

  run = async () => {
    try {
      this.retry();
      return await this.future.asPromise();
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
      }
    }
  };

  private retry = () => {
    if (this.tries >= this.triesMax) {
      this.future.error(new TransactionTimeout());
      return;
    }
    this.protocol.sendStun(this.request, this.addr);
    this.timeoutHandle = setTimeout(this.retry, this.timeoutDelay);
    this.timeoutDelay *= 2;
    this.tries++;
  };
}
