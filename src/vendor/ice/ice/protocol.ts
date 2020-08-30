import * as dgram from "dgram";
import { Event } from "rx.mini";
import { Candidate } from "../candidate";
import { Address, Protocol } from "../model";
import { classes, Message, parseMessage, Transaction } from "../stun/stun";
import { Connection } from "./ice";

export class StunProtocol implements Protocol {
  transactions: { [key: string]: Transaction } = {};
  get transactionsKeys() {
    return Object.keys(this.transactions);
  }
  localCandidate?: Candidate;
  sentMessage?: Message;

  localAddress?: string;

  socket = dgram.createSocket("udp4");
  private closed = new Event();

  constructor(public receiver: Connection) {}

  private log(...args: any[]) {
    if (this.receiver.options.log) {
      console.log("log", ...args);
    }
  }

  connectionLost(exc: any) {
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
      this.datagramReceived(data, [info.address, info.port]);
    });
  };

  private datagramReceived(data: Buffer, addr: Address) {
    let message;
    try {
      message = parseMessage(data);
    } catch (error) {
      // some data received
      // console.log(data);
      this.receiver.dataReceived(data, this.localCandidate?.component!);
      return;
    }
    this.log("parseMessage", addr, message);
    if (
      (message?.messageClass === classes.RESPONSE ||
        message?.messageClass === classes.ERROR) &&
      this.transactionsKeys.includes(message.transactionIdHex)
    ) {
      const transaction = this.transactions[message.transactionIdHex];
      transaction.responseReceived(message, addr);
    } else if (message?.messageClass === classes.REQUEST) {
      this.receiver.requestReceived(message, addr, this, data);
    }
  }

  get getExtraInfo() {
    const { address: host, port } = this.socket.address() as any;
    return [host, port];
  }

  sendStun(message: Message, addr: Address) {
    const [host, port] = addr;
    const data = message.bytes;
    try {
      this.socket.send(data, port, host, (error, size) => {
        this.log("sendStun", port, host, size, error);
      });
    } catch (error) {}
  }

  async sendData(data: Buffer, addr: Address) {
    const [host, port] = addr;
    this.socket.send(data, port, host, (error, size) => {
      this.log("sendData", port, host, size, error);
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
      throw new Error("request");

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    const transaction = new Transaction(request, addr, this, retransmissions);
    transaction.integrityKey = integrityKey;
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } catch (error) {
      throw error;
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async close() {
    await new Promise((r) => {
      this.socket.once("close", r);
      this.socket.close();
    });
  }
}
