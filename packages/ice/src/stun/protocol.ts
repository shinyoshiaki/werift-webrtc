import { isIP } from "node:net";

import type { Address, InterfaceAddresses } from "../../../common/src/network";
import type { Candidate } from "../candidate";
import { TransactionCancelled } from "../exceptions";
import { debug, Event, UdpTransport } from "../imports/common";
import type { Protocol, TransactionRequestOptions } from "../types/model";
import { classes } from "./const";
import { type Message, parseMessage } from "./message";
import {
  buildTransactionOptions,
  resolveRequestAddress,
  Transaction,
} from "./transaction";

const log = debug("werift-ice : packages/ice/src/stun/protocol.ts");

/**
 * Send errors (`code` of the Node.js error) that say the path itself is
 * gone, not that a packet was lost: no route to the network or host, the
 * network or host is down, the local address went away, or a local firewall
 * refuses it. `Protocol.onPathBroken` reports them.
 */
export const PATH_BROKEN_SEND_ERRORS: ReadonlySet<string> = new Set([
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "EPERM",
]);

/** `error` is a send error in {@link PATH_BROKEN_SEND_ERRORS}. */
export const isPathBrokenSendError = (error: unknown): error is Error =>
  error instanceof Error &&
  PATH_BROKEN_SEND_ERRORS.has((error as NodeJS.ErrnoException).code ?? "");

/**
 * Minimum time (ms) between two application-data datagrams of one socket
 * sent with `confirm` (see {@link DataSendConfirmation}). werift's own value.
 */
export const DATA_SEND_CONFIRM_INTERVAL_MS = 100;

/**
 * Which application-data datagrams of one socket are sent with `confirm`:
 * one per {@link DATA_SEND_CONFIRM_INTERVAL_MS}. Node.js reports a datagram's
 * send error only to a completion callback, which costs a round of the event
 * loop per packet; confirming a sample tells a path that is gone within that
 * interval while data flows, at a bounded cost.
 */
export class DataSendConfirmation {
  private lastAt = Number.NEGATIVE_INFINITY;

  /** The datagram sent now is one to confirm. */
  due(now = Date.now()) {
    if (now - this.lastAt < DATA_SEND_CONFIRM_INTERVAL_MS) return false;
    this.lastAt = now;
    return true;
  }
}

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
  /** close() ran: no new transaction starts. */
  private closed = false;

  readonly onRequestReceived = new Event<[Message, Address, Buffer]>();
  readonly onDataReceived = new Event<[Buffer, Address]>();
  /** See `Protocol.onPathBroken`: a datagram to that address could not be sent. */
  readonly onPathBroken = new Event<[Address | undefined, Error]>();
  private readonly dataConfirmation = new DataSendConfirmation();

  constructor() {}

  /**
   * Opens the UDP socket. `bindAddress` binds it to that address (an IPv6
   * link-local one with its zone, `fe80::1%eth0`) instead of the address of
   * `interfaceAddresses` or the wildcard address.
   */
  connectionMade = async (
    useIpv4: boolean,
    portRange?: [number, number],
    interfaceAddresses?: InterfaceAddresses,
    { bindAddress }: { bindAddress?: string } = {},
  ) => {
    this.transport = await UdpTransport.init(useIpv4 ? "udp4" : "udp6", {
      portRange,
      interfaceAddresses,
      bindAddress,
    });

    this.transport.onData = (data, addr) => {
      this.datagramReceived(data, addr);
    };
    this.transport.onError.subscribe((error) => {
      log("transport error", error);
    });
  };

  private datagramReceived(data: Buffer, addr: Address) {
    try {
      const message = parseMessage(data);
      if (!message) {
        if (this.localCandidate) {
          this.onDataReceived.execute(data, addr);
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
        // Re-parse with integrity key so unauthenticated responses are dropped
        // (MESSAGE-INTEGRITY or MESSAGE-INTEGRITY-SHA256, RFC 8489 §9.1.4).
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
    // Confirmed: a STUN message is rare enough to wait for the OS, and its
    // send error tells a path that is gone (application data is not
    // confirmed, for speed).
    await this.transport.send(data, addr, { confirm: true }).catch((error) => {
      log("sendStun failed", addr, message, error);
      if (isPathBrokenSendError(error)) {
        this.onPathBroken.execute(addr, error);
      }
    });
  }

  async sendData(data: Buffer, addr: Address) {
    if (this.transport.closed) {
      return;
    }

    if (!this.dataConfirmation.due()) {
      await this.transport.send(data, addr);
      return;
    }
    try {
      await this.transport.send(data, addr, { confirm: true });
    } catch (error) {
      if (isPathBrokenSendError(error)) {
        this.onPathBroken.execute(addr, error);
      }
      // A datagram to an IP address reported no error before `confirm` (the
      // callers do not expect one); a hostname's lookup error still rejects.
      if (isIP(addr[0]) !== 0) {
        log("sendData failed", addr, error);
        return;
      }
      throw error;
    }
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

    const options = buildTransactionOptions(
      integrityKey,
      retransmissionsOrOptions,
      onRequestSent,
    );
    if (integrityKey) {
      request.addIntegrity(integrityKey, options.integrityAlgorithm);
      request.addFingerprint();
    }

    // Match DNS family to the bound socket so STUN hostname targets resolve correctly.
    const resolvedAddr = await resolveRequestAddress(
      addr,
      this.transport.addressFamily,
    );
    // close() ran during the lookup: a transaction started now would
    // retransmit on the closed socket and keep its timers.
    if (this.closed) throw new TransactionCancelled();

    const transaction: Transaction = new Transaction(
      request,
      resolvedAddr,
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
    this.closed = true;
    Object.values(this.transactions).forEach((transaction) => {
      transaction.cancel();
    });
    await this.transport.close();
    this.onRequestReceived.complete();
    this.onDataReceived.complete();
    this.onPathBroken.complete();
  }
}
