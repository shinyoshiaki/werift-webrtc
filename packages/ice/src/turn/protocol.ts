import { createHash } from "crypto";
import { jspack } from "@shinyoshiaki/jspack";

import { setTimeout } from "timers/promises";

import type { Candidate } from "../candidate";
import { TransactionFailed } from "../exceptions";
import { type Cancelable, cancelable, randomTransactionId } from "../helper";
import {
  type Address,
  Event,
  EventDisposer,
  type InterfaceAddresses,
  TcpTransport,
  type Transport,
  UdpTransport,
  bufferReader,
  debug,
  int,
} from "../imports/common";
import { classes, methods } from "../stun/const";
import { Message, paddingLength, parseMessage } from "../stun/message";
import { Transaction } from "../stun/transaction";

import type { Protocol } from "../types/model";

const log = debug("werift-ice:packages/ice/src/turn/protocol.ts");

const DEFAULT_CHANNEL_REFRESH_TIME = 500;
const DEFAULT_ALLOCATION_LIFETIME = 600;
const UDP_TRANSPORT = 0x11000000;

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
          transaction.responseReceived(message, addr);
        }
      } else if (message.messageClass === classes.REQUEST) {
        this.onRequestReceived.execute(message, addr, data);
      }
    } catch (error) {
      log("datagramReceived error", error);
    }
  };

  async request(request: Message, addr: Address, integrityKey?: Buffer) {
    if (this.turn.transactions[request.transactionIdHex]) {
      throw new Error("exist");
    }

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    const transaction = new Transaction(request, addr, this);
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
  private channelByAddr: {
    [addr: string]: { number: number; address: Address };
  } = {};
  private addrByChannel: { [channel: number]: Address } = {};
  /**sec */
  private channelRefreshTime: number;
  private channelBinding?: Promise<void>;
  private channelRefreshAt = 0;
  private tcpBuffer: Buffer = Buffer.alloc(0);
  private permissionByAddr: { [addr: string]: boolean } = {};
  private creatingPermission: Promise<void> = Promise.resolve();

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
    const [channel, length] = jspack.Unpack("!HH", data.slice(0, 4));
    const addr = this.addrByChannel[channel];

    if (addr) {
      const payload = data.subarray(4, 4 + length);
      this.onData.execute(payload, addr);
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
          transaction.responseReceived(message, addr);
        }
      } else if (message.messageClass === classes.REQUEST) {
        this.onData.execute(data, addr);
      }

      if (message.getAttributeValue("DATA")) {
        const buf: Buffer = message.getAttributeValue("DATA");
        this.onData.execute(buf, addr);
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

    if (this.transport.type === "tcp") {
      this.tcpBuffer = Buffer.concat([this.tcpBuffer, data]);
      while (this.tcpBuffer.length >= 4) {
        let [, length] = bufferReader(this.tcpBuffer.subarray(0, 4), [2, 2]);
        length += paddingLength(length);
        const fullLength = isChannelData(this.tcpBuffer)
          ? 4 + length
          : 20 + length;
        if (this.tcpBuffer.length < fullLength) {
          break;
        }

        datagramReceived(this.tcpBuffer.subarray(0, fullLength), addr);
        this.tcpBuffer = this.tcpBuffer.subarray(fullLength);
      }
    } else {
      datagramReceived(data, addr);
    }
  }

  private async send(data: Buffer, addr: Address) {
    if (this.transport.type === "tcp") {
      const padding = paddingLength(data.length);
      await this.transport.send(
        padding > 0 ? Buffer.concat([data, Buffer.alloc(padding)]) : data,
        addr,
      );
    } else {
      await this.transport.send(data, addr);
    }
  }

  private async createPermission(peerAddress: Address) {
    const request = new Message(methods.CREATE_PERMISSION, classes.REQUEST);
    request
      .setAttribute("XOR-PEER-ADDRESS", peerAddress)
      .setAttribute("USERNAME", this.username)
      .setAttribute("REALM", this.realm)
      .setAttribute("NONCE", this.nonce);
    await this.request(request, this.server).catch((e) => {
      request;
      throw e;
    });
  }

  private refresh = (exp: number) => {
    this.refreshHandle = cancelable<void>(async (_, __, onCancel) => {
      let run = true;
      onCancel.once(() => {
        run = false;
      });

      while (run) {
        // refresh before expire
        const delay = (5 / 6) * exp * 1000;
        log("refresh delay", delay, { exp });
        await setTimeout(delay);

        const request = new Message(methods.REFRESH, classes.REQUEST);
        request.setAttribute("LIFETIME", exp);

        try {
          const [message] = await this.requestWithRetry(request, this.server);
          exp = message.getAttributeValue("LIFETIME");
          log("refresh", { exp });
        } catch (error) {
          log("refresh error", error);
        }
      }
    });
  };

  async request(request: Message, addr: Address): Promise<[Message, Address]> {
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

    const transaction = new Transaction(request, addr, this);
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
  ): Promise<[Message, Address]> {
    let message: Message, address: Address;
    try {
      [message, address] = await this.request(request, addr);
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
        [message, address] = await this.request(request, this.server);
      } else {
        throw error;
      }
    }
    return [message!, address!];
  }

  async sendData(data: Buffer, addr: Address) {
    const channel = await this.getChannel(addr).catch((e) => {
      return new Error("channelBind error");
    });

    if (channel instanceof Error) {
      await this.getPermission(addr);
      const indicate = new Message(methods.SEND, classes.INDICATION)
        .setAttribute("DATA", data)
        .setAttribute("XOR-PEER-ADDRESS", addr);

      await this.sendStun(indicate, this.server);
      return;
    }

    const header = jspack.Pack("!HH", [channel.number, data.length]);
    await this.send(Buffer.concat([Buffer.from(header), data]), this.server);
  }

  async getPermission(addr: Address) {
    await this.creatingPermission;

    const permitted = this.permissionByAddr[addr.join(":")];
    if (!permitted) {
      this.creatingPermission = this.createPermission(addr);
      this.permissionByAddr[addr.join(":")] = true;
      await this.creatingPermission.catch((e) => {
        log("createPermission error", e);
        throw e;
      });
    }
  }

  async getChannel(addr: Address) {
    if (this.channelBinding) {
      await this.channelBinding;
    }

    let channel = this.channelByAddr[addr.join(":")];

    if (!channel) {
      this.channelByAddr[addr.join(":")] = {
        number: this.channelNumber++,
        address: addr,
      };
      channel = this.channelByAddr[addr.join(":")];
      this.addrByChannel[channel.number] = addr;

      this.channelBinding = this.channelBind(channel.number, addr);
      await this.channelBinding.catch((e) => {
        log("channelBind error", e);
        throw e;
      });
      this.channelRefreshAt = int(Date.now() / 1000) + this.channelRefreshTime;
      this.channelBinding = undefined;
      log("channelBind", channel);
    } else if (this.channelRefreshAt < int(Date.now() / 1000)) {
      this.channelBinding = this.channelBind(channel.number, addr);
      this.channelRefreshAt = int(Date.now() / 1000) + this.channelRefreshTime;
      await this.channelBinding.catch((e) => {
        log("channelBind error", e);
        throw e;
      });
      this.channelBinding = undefined;
      log("channelBind refresh", channel);
    }
    return channel;
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
  transport?: "udp" | "tcp";
  portRange?: [number, number];
  interfaceAddresses?: InterfaceAddresses;
}

export async function createTurnClient(
  { address, username, password }: TurnClientConfig,
  {
    lifetime,
    portRange,
    interfaceAddresses,
    transport: transportType,
  }: TurnClientOptions = {},
) {
  lifetime ??= DEFAULT_ALLOCATION_LIFETIME;
  transportType ??= "udp";

  const transport =
    transportType === "udp"
      ? await UdpTransport.init("udp4", { portRange, interfaceAddresses })
      : await TcpTransport.init(address);

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
    transport: transportType,
  }: {
    lifetime?: number;
    ssl?: boolean;
    transport?: "udp" | "tcp";
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
  return createHash("md5")
    .update(Buffer.from([username, realm, password].join(":")))
    .digest();
}

function isChannelData(data: Buffer) {
  return (data[0] & 0xc0) == 0x40;
}
