import debug from "debug";
import { Event } from "rx.mini";

import { Candidate } from "../candidate";
import { Connection } from "../ice";
import { UdpTransport } from "../transport";
import { Address, Protocol } from "../types/model";
import { classes } from "./const";
import { Message, parseMessage } from "./message";
import { Transaction } from "./transaction";

const log = debug("packages/ice/src/stun/protocol.ts");

export class StunProtocol implements Protocol {
  readonly type = "stun";
  transport!: UdpTransport;
  transactions: { [key: string]: Transaction } = {};
  get transactionsKeys() {
    return Object.keys(this.transactions);
  }
  localCandidate?: Candidate;
  sentMessage?: Message;
  localAddress?: string;

  private readonly closed = new Event();

  constructor(public receiver: Connection) {}

  connectionLost() {
    this.closed.execute();
    this.closed.complete();
  }

  connectionMade = async (useIpv4: boolean, portRange?: [number, number]) => {
    if (useIpv4) {
      this.transport = await UdpTransport.init("udp4", portRange);
    } else {
      this.transport = await UdpTransport.init("udp6", portRange);
    }

    this.transport.onData = (data, addr) => this.datagramReceived(data, addr);
  };

  private datagramReceived(data: Buffer, addr: Address) {
    if (!this.localCandidate) throw new Error("not exist");

    const message = parseMessage(data);
    if (!message) {
      this.receiver.dataReceived(data, this.localCandidate.component);
      return;
    }
    // log("parseMessage", addr, message);
    if (
      (message.messageClass === classes.RESPONSE ||
        message.messageClass === classes.ERROR) &&
      this.transactionsKeys.includes(message.transactionIdHex)
    ) {
      const transaction = this.transactions[message.transactionIdHex];
      transaction.responseReceived(message, addr);
    } else if (message.messageClass === classes.REQUEST) {
      this.receiver.requestReceived(message, addr, this, data);
    }
  }

  getExtraInfo(): Address {
    const { address: host, port } = this.transport.address();
    return [host, port];
  }

  async sendStun(message: Message, addr: Address) {
    const data = message.bytes;
    await this.transport.send(data, addr).catch(() => {
      log("sendStun failed", addr, message);
    });
  }

  async sendData(data: Buffer, addr: Address) {
    await this.transport.send(data, addr);
  }

  async request(
    request: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissions?: number
  ) {
    // """
    // Execute a STUN transaction and return the response.
    // """
    if (this.transactionsKeys.includes(request.transactionIdHex))
      throw new Error("already request ed");

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    const transaction: Transaction = new Transaction(
      request,
      addr,
      this,
      retransmissions
    );
    transaction.integrityKey = integrityKey;
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async close() {
    Object.values(this.transactions).forEach((transaction) => {
      transaction.cancel();
    });
    await this.transport.close();
  }
}
