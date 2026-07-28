import { Event, UdpTransport, debug } from "../imports/common";

import type { Address, InterfaceAddresses } from "../../../common/src/network";
import type { Candidate } from "../candidate";

import type { Protocol, TransactionRequestOptions } from "../types/model";
import { classes } from "./const";
import { type Message, parseMessage } from "./message";
import { Transaction, buildTransactionOptions } from "./transaction";

const log = debug("werift-ice : packages/ice/src/stun/protocol.ts");

export class StunProtocol implements Protocol {
  static readonly type = "stun";
  readonly type = StunProtocol.type;
  transport!: UdpTransport;
  transactions: { [key: string]: Transaction } = {};
  get transactionsKeys() {
    return Object.keys(this.transactions);
  }
  localCandidate?: Candidate;
  sentMessage?: Message;
  localIp?: string;

  readonly onRequestReceived = new Event<[Message, Address, Buffer]>();
  readonly onDataReceived = new Event<[Buffer]>();

  constructor() {}

  connectionMade = async (
    useIpv4: boolean,
    portRange?: [number, number],
    interfaceAddresses?: InterfaceAddresses,
  ) => {
    if (useIpv4) {
      this.transport = await UdpTransport.init("udp4", {
        portRange,
        interfaceAddresses,
      });
    } else {
      this.transport = await UdpTransport.init("udp6", {
        portRange,
        interfaceAddresses,
      });
    }

    this.transport.onData = (data, addr) => {
      this.datagramReceived(data, addr);
    };
  };

  private datagramReceived(data: Buffer, addr: Address) {
    try {
      const message = parseMessage(data);
      if (!message) {
        if (this.localCandidate) {
          this.onDataReceived.execute(data);
        }
        return;
      }
      // log("parseMessage", addr, message.toJSON());
      if (
        (message.messageClass === classes.RESPONSE ||
          message.messageClass === classes.ERROR) &&
        this.transactionsKeys.includes(message.transactionIdHex)
      ) {
        const transaction = this.transactions[message.transactionIdHex];
        // Re-parse with integrity key so unauthenticated responses are dropped.
        const verified = transaction.integrityKey
          ? parseMessage(data, transaction.integrityKey)
          : message;
        if (!verified) {
          log("STUN response failed MESSAGE-INTEGRITY check");
          return;
        }
        transaction.responseReceived(verified, addr);
      } else if (message.messageClass === classes.REQUEST) {
        this.onRequestReceived.execute(message, addr, data);
      }
    } catch (error) {
      log("datagramReceived error", error);
    }
  }

  getExtraInfo(): Address {
    const { address: host, port } = this.transport.address;
    return [host, port];
  }

  async sendStun(message: Message, addr: Address) {
    if (this.transport.closed) {
      return;
    }

    const data = message.bytes;
    await this.transport.send(data, addr).catch(() => {
      log("sendStun failed", addr, message);
    });
  }

  async sendData(data: Buffer, addr: Address) {
    if (this.transport.closed) {
      return;
    }

    await this.transport.send(data, addr);
  }

  async request(
    request: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissionsOrOptions?: number | TransactionRequestOptions,
    onRequestSent?: (attempt: number) => void,
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

    const options = buildTransactionOptions(
      integrityKey,
      retransmissionsOrOptions,
      onRequestSent,
    );
    const transaction: Transaction = new Transaction(
      request,
      addr,
      this,
      options,
    );
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } catch (e) {
      throw e;
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async close() {
    Object.values(this.transactions).forEach((transaction) => {
      transaction.cancel();
    });
    await this.transport.close();
    this.onRequestReceived.complete();
    this.onDataReceived.complete();
  }
}
