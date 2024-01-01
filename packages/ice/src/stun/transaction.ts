import debug from "debug";
import { Event } from "rx.mini";

import { TransactionFailed, TransactionTimeout } from "../exceptions";
import { Address, Protocol } from "../types/model";
import { RETRY_MAX, RETRY_RTO, classes } from "./const";
import { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

export class Transaction {
  private timeoutDelay = RETRY_RTO;
  private timeoutHandle?: any;
  private tries = 0;
  private readonly triesMax: number;
  private readonly onResponse = new Event<[Message, Address]>();

  constructor(
    private request: Message,
    private addr: Address,
    private protocol: Protocol,
    private retransmissions?: number,
  ) {
    this.triesMax =
      1 + (this.retransmissions ? this.retransmissions : RETRY_MAX);
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
    } catch (error) {
      log(
        "transaction run failed",
        error,
        this.protocol.type,
        this.request.toJSON(),
      );

      throw error;
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
    this.protocol.sendStun(this.request, this.addr).catch((e) => {
      log("send stun failed", e);
    });
    this.timeoutHandle = setTimeout(this.retry, this.timeoutDelay);
    this.timeoutDelay *= 2;
    this.tries++;
  };

  cancel() {
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
  }
}
