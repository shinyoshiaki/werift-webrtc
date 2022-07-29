import debug from "debug";
import { Event } from "rx.mini";

import { TransactionFailed, TransactionTimeout } from "../exceptions";
import { Address, Protocol } from "../types/model";
import { classes, RETRY_MAX, RETRY_RTO } from "./const";
import { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

export class Transaction {
  private timeoutDelay = RETRY_RTO;
  private timeoutHandle?: any;
  private tries = 0;
  private retransmissions? = 0;
  private readonly triesMax: any = {}
  private readonly onResponse = new Event<[Message, Address]>()
  constructor(
    private request: Message,
    private addr: Address,
    private protocol: Protocol,
    _retransmissions?: number
  ) {
    this.retransmissions = _retransmissions;
    this.triesMax = 1 + (this.retransmissions ? this.retransmissions : RETRY_MAX);
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
      log(`retry failed times:${this.tries} maxLimit:${this.triesMax}`);
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
