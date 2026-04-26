import { type Address, Event, debug } from "../imports/common";

import { TransactionFailed, TransactionTimeout } from "../exceptions";
import type { Protocol } from "../types/model";
import { RETRY_MAX, RETRY_RTO, classes } from "./const";
import type { Message } from "./message";

const log = debug("werift-ice:packages/ice/src/stun/transaction.ts");

export class Transaction {
  private timeoutDelay = RETRY_RTO;
  ended = false;
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

  private retry = async () => {
    while (this.tries < this.triesMax && !this.ended) {
      this.protocol.sendStun(this.request, this.addr).catch((e) => {
        log("send stun failed", e);
      });
      await new Promise((r) => setTimeout(r, this.timeoutDelay));
      if (this.ended) {
        break;
      }
      this.timeoutDelay *= 2;
      this.tries++;
    }
    if (this.tries >= this.triesMax) {
      log(`retry failed times:${this.tries} maxLimit:${this.triesMax}`);
      this.onResponse.error(new TransactionTimeout());
    }
  };

  cancel() {
    this.ended = true;
  }
}
