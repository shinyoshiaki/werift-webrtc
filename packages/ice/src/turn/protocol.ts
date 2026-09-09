import { setTimeout } from "timers/promises";

import { makeTurnIntegrityKey } from "../../../ice-server/src/turn/auth";
import type { Candidate } from "../candidate";
import { TransactionFailed } from "../exceptions";
import { type Cancelable, cancelable, randomTransactionId } from "../helper";
import {
  type Address,
  Event,
  EventDisposer,
  type InterfaceAddresses,
  TcpTransport,
  type TlsConnectionOptions,
  TlsTransport,
  type Transport,
  UdpTransport,
  bufferReader,
  debug,
  int,
} from "../imports/common";
import { classes, methods } from "../stun/const";
import { Message, paddingLength, parseMessage } from "../stun/message";
import {
  Transaction,
  buildTransactionOptions,
  resolveRequestAddress,
} from "../stun/transaction";
import type { Protocol, TransactionRequestOptions } from "../types/model";
import {
  decodeChannelData,
  encodeChannelData,
  isChannelData,
  padTurnFrame,
  splitTurnTcpFrames,
} from "./frame";

const log = debug("werift-ice:packages/ice/src/turn/protocol.ts");

const DEFAULT_CHANNEL_REFRESH_TIME = 500;
const DEFAULT_ALLOCATION_LIFETIME = 600;
const UDP_TRANSPORT = 0x11000000;

/** Channel binding state for a single peer transport address. */
export interface TurnChannel {
  number: number;
  address: Address;
  /** Unix seconds when this channel should be refreshed. */
  refreshAt: number;
}

function isStreamTransport(transport: Transport) {
  return transport.type === "tcp" || transport.type === "tls";
}

/** Permission is peer-IP scoped (RFC 8656). */
function permissionKey(addr: Address): string {
  return addr[0];
}

/** ChannelBind is peer transport-address scoped (IP + port). */
function channelKey(addr: Address): string {
  return JSON.stringify(addr);
}

export class StunOverTurnProtocol implements Protocol {
  static type = "turn";
  readonly type = StunOverTurnProtocol.type;
  localCandidate!: Candidate;
  private disposer = new EventDisposer();
  onRequestReceived: Event<[Message, Address, Buffer]> = new Event();
  onDataReceived: Event<[Buffer]> = new Event();

  constructor(public turn: TurnProtocol) {
    turn.onData
      .subscribe((data, addr) => {
        this.handleStunMessage(data, addr);
      })
      .disposer(this.disposer);
  }

  private handleStunMessage = (data: Buffer, addr: Address) => {
    try {
      const message = parseMessage(data);
      if (!message) {
        this.onDataReceived.execute(data);
        return;
      }

      if (
        message.messageClass === classes.RESPONSE ||
        message.messageClass === classes.ERROR
      ) {
        const transaction = this.turn.transactions[message.transactionIdHex];
        if (transaction) {
          const verified = transaction.integrityKey
            ? parseMessage(data, transaction.integrityKey)
            : message;
          if (!verified) {
            log("STUN over TURN response failed MESSAGE-INTEGRITY check");
            return;
          }
          transaction.responseReceived(verified, addr);
        }
      } else if (message.messageClass === classes.REQUEST) {
        this.onRequestReceived.execute(message, addr, data);
      }
    } catch (error) {
      log("datagramReceived error", error);
    }
  };

  async request(
    request: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissionsOrOptions?: number | TransactionRequestOptions,
    onRequestSent?: (attempt: number) => void,
  ) {
    if (this.turn.transactions[request.transactionIdHex]) {
      throw new Error("exist");
    }

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    // Peer-facing STUN over TURN must honor retransmissions/responseTimeout
    // (consent uses retransmissions: 0). Do not confuse with TURN server
    // allocation/refresh policy on TurnProtocol.
    // Peer addresses are already IPs from candidates; resolve for safety.
    const resolvedAddr = await resolveRequestAddress(addr);
    const options = buildTransactionOptions(
      integrityKey,
      retransmissionsOrOptions,
      onRequestSent,
    );
    const transaction = new Transaction(request, resolvedAddr, this, options);
    this.turn.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } catch (e) {
      throw e;
    } finally {
      delete this.turn.transactions[request.transactionIdHex];
    }
  }
  async connectionMade() {}
  async sendData(data: Buffer, addr: Address) {
    await this.turn.sendData(data, addr);
  }
  async sendStun(message: Message, addr: Address) {
    await this.turn.sendData(message.bytes, addr);
  }
  async close() {
    this.disposer.dispose();
    return this.turn.close();
  }
}

export class TurnProtocol implements Protocol {
  static type = "turn";
  readonly type = TurnProtocol.type;
  readonly onData = new Event<[Buffer, Address]>();
  onRequestReceived: Event<[Message, Address, Buffer]> = new Event();
  onDataReceived: Event<[Buffer]> = new Event();
  integrityKey?: Buffer;
  nonce?: Buffer;
  realm?: string;
  relayedAddress!: Address;
  mappedAddress!: Address;
  localCandidate!: Candidate;
  transactions: { [hexId: string]: Transaction } = {};
  private refreshHandle?: Cancelable<void>;
  private channelNumber = 0x4000;
  private channelByAddr: { [key: string]: TurnChannel } = {};
  private addrByChannel: { [channel: number]: Address } = {};
  /**sec */
  private channelRefreshTime: number;
  /**
   * Serializes ChannelBind requests so allocation-wide auth state
   * (nonce/realm/integrityKey) is not updated concurrently. Rejections
   * must not poison this tail — see channelBindQueue assignment sites.
   */
  private channelBindQueue: Promise<void> = Promise.resolve();
  /** In-flight ChannelBind per peer transport address (dedupe concurrent). */
  private channelBindingByAddr = new Map<string, Promise<TurnChannel>>();
  private tcpBuffer: Buffer = Buffer.alloc(0);
  /** Permission cache keyed by peer IP only (RFC 8656). */
  private permissionByAddr: { [peerIp: string]: boolean } = {};
  /**
   * Serializes CreatePermission requests (auth state race avoidance).
   * Rejections must not poison this tail.
   */
  private permissionQueue: Promise<void> = Promise.resolve();
  /** In-flight CreatePermission per peer IP (dedupe concurrent). */
  private creatingPermissionByAddr = new Map<string, Promise<void>>();

  constructor(
    public server: Address,
    public username: string,
    public password: string,
    public lifetime: number,
    public transport: Transport,
    public options: {
      /**sec */
      channelRefreshTime?: number;
    } = {},
  ) {
    this.channelRefreshTime =
      this.options.channelRefreshTime ?? DEFAULT_CHANNEL_REFRESH_TIME;
  }

  async connectionMade() {
    this.transport.onData = (data, addr) => {
      this.dataReceived(data, addr);
    };

    const request = new Message(methods.ALLOCATE, classes.REQUEST);
    request
      .setAttribute("LIFETIME", this.lifetime)
      .setAttribute("REQUESTED-TRANSPORT", UDP_TRANSPORT);

    const [response] = await this.requestWithRetry(request, this.server).catch(
      (e) => {
        log("connect error", e);
        throw e;
      },
    );
    this.relayedAddress = response.getAttributeValue("XOR-RELAYED-ADDRESS");
    this.mappedAddress = response.getAttributeValue("XOR-MAPPED-ADDRESS");
    const exp = response.getAttributeValue("LIFETIME");
    log("connect", this.relayedAddress, this.mappedAddress, { exp });

    this.refresh(exp);
  }

  private handleChannelData(data: Buffer) {
    const decoded = decodeChannelData(data);
    const addr = decoded && this.addrByChannel[decoded.channelNumber];

    if (addr && decoded) {
      this.onData.execute(decoded.data, addr);
    }
  }

  private handleSTUNMessage(data: Buffer, addr: Address) {
    try {
      const message = parseMessage(data);
      if (!message) {
        throw new Error("not stun message");
      }

      if (
        message.messageClass === classes.RESPONSE ||
        message.messageClass === classes.ERROR
      ) {
        const transaction = this.transactions[message.transactionIdHex];
        if (transaction) {
          const verified = transaction.integrityKey
            ? parseMessage(data, transaction.integrityKey)
            : message;
          if (!verified) {
            log("TURN STUN response failed MESSAGE-INTEGRITY check");
            return;
          }
          transaction.responseReceived(verified, addr);
        }
      } else if (message.messageClass === classes.REQUEST) {
        this.onData.execute(data, addr);
      }

      if (message.getAttributeValue("DATA")) {
        const buf: Buffer = message.getAttributeValue("DATA");
        const peerAddress =
          message.getAttributeValue("XOR-PEER-ADDRESS") ?? addr;
        this.onData.execute(buf, peerAddress);
      }
    } catch (error) {
      log("parse error", data.toString());
    }
  }

  private dataReceived(data: Buffer, addr: Address) {
    const datagramReceived = (data: Buffer, addr: Address) => {
      if (data.length >= 4 && isChannelData(data)) {
        this.handleChannelData(data);
      } else {
        this.handleSTUNMessage(data, addr);
      }
    };

    if (isStreamTransport(this.transport)) {
      this.tcpBuffer = Buffer.concat([this.tcpBuffer, data]);
      const { frames, rest } = splitTurnTcpFrames(this.tcpBuffer);
      this.tcpBuffer = rest;
      for (const frame of frames) {
        datagramReceived(frame, addr);
      }
    } else {
      datagramReceived(data, addr);
    }
  }

  private async send(data: Buffer, addr: Address) {
    if (this.transport.closed) {
      return;
    }

    await this.transport.send(
      isStreamTransport(this.transport) ? padTurnFrame(data) : data,
      addr,
    );
  }

  private async createPermission(peerAddress: Address) {
    const request = new Message(methods.CREATE_PERMISSION, classes.REQUEST);
    request
      .setAttribute("XOR-PEER-ADDRESS", peerAddress)
      .setAttribute("USERNAME", this.username)
      .setAttribute("REALM", this.realm)
      .setAttribute("NONCE", this.nonce);
    // Use requestWithRetry for stale-nonce (438) consistency with ChannelBind.
    await this.requestWithRetry(request, this.server);
  }

  private refresh = (exp: number) => {
    this.refreshHandle = cancelable<void>(async (_, __, onCancel) => {
      const abort = new AbortController();
      onCancel.once(() => {
        abort.abort();
      });

      while (!abort.signal.aborted) {
        // refresh before expire
        const delay = (5 / 6) * exp * 1000;
        log("refresh delay", delay, { exp });
        try {
          await setTimeout(delay, undefined, { signal: abort.signal });
        } catch (error) {
          if (abort.signal.aborted) {
            return;
          }
          throw error;
        }

        if (abort.signal.aborted) {
          return;
        }

        const request = new Message(methods.REFRESH, classes.REQUEST);
        request.setAttribute("LIFETIME", exp);

        try {
          const [message] = await this.requestWithRetry(
            request,
            this.server,
            abort.signal,
          );
          exp = message.getAttributeValue("LIFETIME");
          log("refresh", { exp });
        } catch (error) {
          if (abort.signal.aborted) {
            return;
          }
          log("refresh error", error);
        }
      }
    });
  };

  async request(
    request: Message,
    addr: Address,
    _integrityKey?: Buffer,
    retransmissionsOrOptions?: number | TransactionRequestOptions,
    onRequestSent?: (attempt: number) => void,
  ): Promise<[Message, Address]> {
    if (this.transactions[request.transactionIdHex]) {
      throw new Error("exist");
    }
    if (this.integrityKey) {
      request
        .setAttribute("USERNAME", this.username)
        .setAttribute("REALM", this.realm)
        .setAttribute("NONCE", this.nonce)
        .addMessageIntegrity(this.integrityKey)
        .addFingerprint();
    }

    // TURN server allocation/refresh uses default STUN retry policy unless
    // callers pass explicit options. Peer consent goes through StunOverTurnProtocol.
    // Prefer the TURN session integrity key for response verification.
    const resolvedAddr = await resolveRequestAddress(addr);
    const options = buildTransactionOptions(
      this.integrityKey,
      retransmissionsOrOptions,
      onRequestSent,
    );
    const transaction = new Transaction(request, resolvedAddr, this, options);
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } catch (e) {
      throw e;
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async requestWithRetry(
    request: Message,
    addr: Address,
    signal?: AbortSignal,
  ): Promise<[Message, Address]> {
    let message: Message, address: Address;
    try {
      [message, address] = await this.request(request, addr, undefined, {
        signal,
      });
    } catch (error) {
      if (error instanceof TransactionFailed == false) {
        log("requestWithRetry error", error);
        throw error;
      }

      // resolve dns address
      this.server = error.addr;

      const [errorCode] = error.response.getAttributeValue("ERROR-CODE");
      const nonce = error.response.getAttributeValue("NONCE");
      const realm = error.response.getAttributeValue("REALM");

      if (
        ((errorCode === 401 && realm) || (errorCode === 438 && this.realm)) &&
        nonce
      ) {
        log("retry with nonce", errorCode);

        this.nonce = nonce;
        if (errorCode === 401) {
          this.realm = realm;
        }
        this.integrityKey = makeIntegrityKey(
          this.username,
          this.realm!,
          this.password,
        );

        request.transactionId = randomTransactionId();
        [message, address] = await this.request(
          request,
          this.server,
          undefined,
          { signal },
        );
      } else {
        throw error;
      }
    }
    return [message!, address!];
  }

  async sendData(data: Buffer, addr: Address) {
    let channel: TurnChannel | undefined;
    try {
      channel = await this.getChannel(addr);
    } catch (e) {
      // Keep original ChannelBind error for diagnostics (403/438/timeout).
      log("channelBind error; falling back to Send Indication", e);
    }

    if (!channel) {
      await this.getPermission(addr);
      const indicate = new Message(methods.SEND, classes.INDICATION)
        .setAttribute("DATA", data)
        .setAttribute("XOR-PEER-ADDRESS", addr);

      await this.sendStun(indicate, this.server);
      return;
    }

    await this.send(encodeChannelData(channel.number, data), this.server);
  }

  /**
   * Ensure a CreatePermission exists for the peer IP.
   * Peer failures are isolated: a rejection for peer A does not poison peer B.
   */
  async getPermission(addr: Address) {
    const key = permissionKey(addr);

    if (this.permissionByAddr[key]) {
      return;
    }

    const existing = this.creatingPermissionByAddr.get(key);
    if (existing) {
      return existing;
    }

    const operation = this.permissionQueue.then(async () => {
      // Another caller may have succeeded while we waited on the queue.
      if (this.permissionByAddr[key]) {
        return;
      }

      await this.createPermission(addr);
      // Cache only after successful CreatePermission.
      this.permissionByAddr[key] = true;
    });

    // Do not let rejection poison subsequent peers on the shared queue.
    this.permissionQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    this.creatingPermissionByAddr.set(key, operation);

    try {
      await operation;
    } catch (error) {
      log("createPermission error", error);
      throw error;
    } finally {
      if (this.creatingPermissionByAddr.get(key) === operation) {
        this.creatingPermissionByAddr.delete(key);
      }
    }
  }

  /**
   * Ensure a ChannelBind exists for the peer transport address.
   * Peer failures are isolated; concurrent same-peer calls share one Promise.
   */
  async getChannel(addr: Address): Promise<TurnChannel> {
    const key = channelKey(addr);

    const existing = this.channelBindingByAddr.get(key);
    if (existing) {
      return existing;
    }

    // Fast path: bound and not due for refresh.
    const cached = this.channelByAddr[key];
    const now = int(Date.now() / 1000);
    if (cached && cached.refreshAt > now) {
      return cached;
    }

    const operation = this.channelBindQueue.then(() =>
      this.ensureChannel(addr),
    );

    // Do not let rejection poison subsequent peers on the shared queue.
    this.channelBindQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    this.channelBindingByAddr.set(key, operation);

    try {
      return await operation;
    } catch (error) {
      log("channelBind error", error);
      throw error;
    } finally {
      if (this.channelBindingByAddr.get(key) === operation) {
        this.channelBindingByAddr.delete(key);
      }
    }
  }

  /**
   * Create or refresh a channel for addr. Provisional mapping is installed
   * before the request so early ChannelData can be decoded; only a failed
   * *initial* bind rolls the mapping back. Failed channel numbers are never
   * reused.
   */
  private async ensureChannel(addr: Address): Promise<TurnChannel> {
    const key = channelKey(addr);
    const now = int(Date.now() / 1000);

    let channel = this.channelByAddr[key];
    if (channel && channel.refreshAt > now) {
      return channel;
    }

    const isNew = !channel;

    if (!channel) {
      channel = {
        number: this.channelNumber++,
        address: addr,
        refreshAt: 0,
      };
      // Provisional mapping for ChannelData that may arrive before success.
      this.channelByAddr[key] = channel;
      this.addrByChannel[channel.number] = addr;
    }

    try {
      await this.channelBind(channel.number, addr);
      channel.refreshAt = int(Date.now() / 1000) + this.channelRefreshTime;
      log(isNew ? "channelBind" : "channelBind refresh", channel);
      return channel;
    } catch (error) {
      if (isNew) {
        // Roll back provisional mapping only for a failed initial bind.
        delete this.channelByAddr[key];
        delete this.addrByChannel[channel.number];
        // Do not reuse the channel number (no channelNumber--).
      }
      throw error;
    }
  }

  private async channelBind(channelNumber: number, addr: Address) {
    const request = new Message(methods.CHANNEL_BIND, classes.REQUEST);
    request
      .setAttribute("CHANNEL-NUMBER", channelNumber)
      .setAttribute("XOR-PEER-ADDRESS", addr);
    const [response] = await this.requestWithRetry(request, this.server);
    if (response.messageMethod !== methods.CHANNEL_BIND) {
      throw new Error("should be CHANNEL_BIND");
    }
  }

  async sendStun(message: Message, addr: Address) {
    await this.send(message.bytes, addr);
  }

  async close() {
    this.refreshHandle?.resolve?.();
    await this.transport.close();
  }
}

export interface TurnClientConfig {
  address: Address;
  username: string;
  password: string;
}
export interface TurnClientOptions {
  lifetime?: number;
  ssl?: boolean;
  transport?: "udp" | "tcp" | "tls";
  tlsOptions?: TlsConnectionOptions;
  portRange?: [number, number];
  interfaceAddresses?: InterfaceAddresses;
}

export async function createTurnClient(
  { address, username, password }: TurnClientConfig,
  {
    lifetime,
    portRange,
    interfaceAddresses,
    ssl,
    tlsOptions,
    transport: transportType,
  }: TurnClientOptions = {},
) {
  lifetime ??= DEFAULT_ALLOCATION_LIFETIME;
  transportType ??= ssl ? "tls" : "udp";

  const transport =
    transportType === "udp"
      ? await UdpTransport.init("udp4", { portRange, interfaceAddresses })
      : transportType === "tcp"
        ? await TcpTransport.init(address)
        : await TlsTransport.init(address, tlsOptions);

  const turn = new TurnProtocol(
    address,
    username,
    password,
    lifetime,
    transport,
  );

  await turn.connectionMade();
  return turn;
}

export async function createStunOverTurnClient(
  {
    address,
    username,
    password,
  }: {
    address: Address;
    username: string;
    password: string;
  },
  {
    lifetime,
    portRange,
    interfaceAddresses,
    ssl,
    tlsOptions,
    transport: transportType,
  }: {
    lifetime?: number;
    ssl?: boolean;
    transport?: "udp" | "tcp" | "tls";
    tlsOptions?: TlsConnectionOptions;
    portRange?: [number, number];
    interfaceAddresses?: InterfaceAddresses;
  } = {},
) {
  const turn = await createTurnClient(
    {
      address,
      username,
      password,
    },
    {
      lifetime,
      portRange,
      interfaceAddresses,
      ssl,
      tlsOptions,
      transport: transportType,
    },
  );
  const turnTransport = new StunOverTurnProtocol(turn);
  return turnTransport;
}

export function makeIntegrityKey(
  username: string,
  realm: string,
  password: string,
) {
  return makeTurnIntegrityKey(username, realm, password);
}
