import debug from "debug";
import * as dgram from "dgram";
import { Event } from "rx.mini";
import { Candidate } from "../candidate";
import { Connection } from "../ice";
import { Address, Protocol } from "../types/model";
import { classes } from "./const";
import { Message, parseMessage } from "./message";
import { Transaction } from "./transaction";

const log = debug("werift/ice/stun/protocol");

export class StunProtocol implements Protocol {
  readonly type = "stun";
  socket = dgram.createSocket("udp4");
  transactions: { [key: string]: Transaction } = {};
  get transactionsKeys() {
    return Object.keys(this.transactions);
  }
  localCandidate!: Candidate;
  sentMessage?: Message;
  localAddress?: string;

  private readonly closed = new Event();

  constructor(public receiver: Connection) {}

  connectionLost() {
    this.closed.execute();
    this.closed.complete();
  }

  connectionMade = async (useIpv4: boolean) => {
    if (!useIpv4) {
      this.socket = dgram.createSocket("udp6");
    }
    this.socket.bind();
    await new Promise((r) => this.socket.once("listening", r));
    this.socket.on("message", (data, info) => {
      if (info.family === "IPv6") {
        [info.address] = info.address.split("%"); // example fe80::1d3a:8751:4ffd:eb80%wlp82s0
      }
      this.datagramReceived(data, [info.address, info.port]);
    });
  };

  private datagramReceived(data: Buffer, addr: Address) {
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

  get getExtraInfo(): [string, number] {
    const { address: host, port } = this.socket.address();
    return [host, port];
  }

  sendStun(message: Message, addr: Address) {
    const [host, port] = addr;
    const data = message.bytes;
    try {
      this.socket.send(data, port, host, (error, size) => {
        if (error) log("sendStun", port, host, size, error);
      });
    } catch (error) {}
  }

  async sendData(data: Buffer, addr: Address) {
    const [host, port] = addr;
    this.socket.send(data, port, host, (error, size) => {
      if (error) log("sendData", port, host, size, error);
    });
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
    await new Promise<void>((r) => {
      this.socket.once("close", r);
      try {
        this.socket.close();
      } catch (error) {
        r();
      }
    });
  }
}
