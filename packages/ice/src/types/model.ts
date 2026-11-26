import type { Candidate } from "../candidate";
import type { Address, Event } from "../imports/common";
import type { MessageIntegrityMode } from "../stun/const";
import type { Message } from "../stun/message";

/**
 * Options for a STUN transaction / Protocol.request.
 * Retransmission count and response wait deadline are independent
 * so consent freshness (retransmissions: 0, longer timeout) can be expressed.
 */
export interface TransactionRequestOptions {
  /** Number of retransmissions after the initial send. 0 = send once. */
  retransmissions?: number;
  /**
   * Initial response wait deadline in milliseconds.
   * Doubled after each retransmission when retransmissions > 0.
   * Defaults to RETRY_RTO when omitted.
   */
  responseTimeout?: number;
  /** Called for each wire send (attempt 0 is the initial transmission). */
  onRequestSent?: (attempt: number) => void;
  /** Abort the outstanding transaction (e.g. consent lifecycle teardown). */
  signal?: AbortSignal;
  /**
   * Fail the transaction as soon as the request cannot be sent instead of
   * waiting for the response timeout. Used on reliable transports (TCP),
   * where a send error means the connection itself is unusable.
   */
  failOnSendError?: boolean;
  /**
   * When set, responses must include MESSAGE-INTEGRITY or
   * MESSAGE-INTEGRITY-SHA256 and pass HMAC verification (protocol re-parses
   * the wire bytes with this key; the transaction also rejects unsigned
   * Messages as defense-in-depth). Unsigned or forged responses must not
   * complete the transaction.
   */
  integrityKey?: Buffer;
  /**
   * Integrity attributes a request signed with `integrityKey` carries.
   * Defaults to `"sha1"` (MESSAGE-INTEGRITY only). Responses are accepted
   * with either algorithm regardless of this choice. Ignored by the TURN
   * client's own long-term credential requests (TurnProtocol), which stay
   * MESSAGE-INTEGRITY only.
   */
  integrityAlgorithm?: MessageIntegrityMode;
}

export interface Protocol {
  type: string;
  onRequestReceived: Event<[Message, Address, Buffer]>;
  /** Application data (not STUN) and the remote address it came from. */
  onDataReceived: Event<[Buffer, Address]>;
  /** Connection-oriented protocols: the connection to this remote address is gone. */
  onConnectionClosed?: Event<[Address]>;
  /**
   * Sending failed in a way that says the path is gone, not just a lost
   * packet: a routing error from the OS for this remote address (see
   * `PATH_BROKEN_SEND_ERRORS`), or, with no address, every path of the
   * protocol (its TURN allocation is lost: the connection to the TURN
   * server closed, a Refresh failed, the server is unreachable). The ICE
   * agent fails over at once instead of waiting for unanswered checks.
   */
  onPathBroken?: Event<[Address | undefined, Error]>;
  request: (
    message: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissionsOrOptions?: number | TransactionRequestOptions,
    onRequestSent?: (attempt: number) => void,
  ) => Promise<[Message, Address]>;
  close: () => Promise<void>;
  connectionMade: (...args: any) => Promise<void>;
  sendStun: (message: Message, addr: Address) => Promise<void>;
  sendData: (data: Buffer, addr: Address) => Promise<void>;
  localCandidate?: Candidate;
  sentMessage?: Message;
  responseAddr?: Address;
  responseMessage?: string;
  localIp?: string;
}
