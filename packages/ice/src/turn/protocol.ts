import { createHash } from "crypto";
import { createSocket } from "dgram";
import { jspack } from "jspack";
import PCancelable from "p-cancelable";
import Event from "rx.mini";
import { Candidate } from "../candidate";
import { TransactionFailed } from "../exceptions";
import { Connection } from "../ice";
import { classes, methods } from "../stun/const";
import { Message, parseMessage } from "../stun/message";
import { Transaction } from "../stun/transaction";
import { Address, Protocol } from "../typings/model";
import { future, Future, randomTransactionId, sleep } from "../utils";

const TCP_TRANSPORT = 0x06000000;
const UDP_TRANSPORT = 0x11000000;

class TurnTransport implements Protocol {
  type = "turn";
  localCandidate: Candidate | undefined;

  receiver?: Connection;

  constructor(public turn: TurnClient) {
    turn.onDatagramReceived = this.datagramReceived;
  }

  private datagramReceived = (data: Buffer, addr: Address) => {
    const message = parseMessage(data);
    if (!message) {
      this.receiver?.dataReceived(data, this.localCandidate!.component);
      return;
    }

    if (
      (message?.messageClass === classes.RESPONSE ||
        message?.messageClass === classes.ERROR) &&
      this.turn.transactions[message.transactionIdHex]
    ) {
      const transaction = this.turn.transactions[message.transactionIdHex];
      transaction.responseReceived(message, addr);
    } else if (message?.messageClass === classes.REQUEST) {
      this.receiver?.requestReceived(message, addr, this, data);
    }
  };

  async request(request: Message, addr: Address, integrityKey?: Buffer) {
    if (this.turn.transactions[request.transactionIdHex])
      throw new Error("exist");

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    const transaction = new Transaction(request, addr, this);
    transaction.integrityKey = integrityKey;
    this.turn.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
      // eslint-disable-next-line no-useless-catch
    } catch (error) {
      throw error;
    } finally {
      delete this.turn.transactions[request.transactionIdHex];
    }
  }
  async connectionMade() {}
  async sendData(data: Buffer, addr: Address) {
    await this.turn.sendData(data, addr);
  }
  async sendStun(message: Message, addr: Address) {
    this.turn.sendData(message.bytes, addr);
  }
}

class TurnClient implements Protocol {
  type = "inner_turn";
  onData = new Event<[Buffer, Address]>();
  transactions: { [hexId: string]: Transaction } = {};
  integrityKey?: Buffer;
  nonce?: Buffer;
  realm?: string;
  relayedAddress?: Address;
  mappedAddress?: Address;
  refreshHandle?: Future;
  channelNumber = 0x4000;
  channelByAddr: { [key: string]: number } = {};
  addrByChannel: { [key: number]: Address } = {};
  localCandidate: Candidate | undefined;

  onDatagramReceived: (data: Buffer, addr: Address) => void = () => {};

  constructor(
    public server: Address,
    public username: string,
    public password: string,
    public lifetime: number,
    public transport: Transport
  ) {}

  async connectionMade() {
    this.transport.onData = (data, addr) => {
      this.datagramReceived(data, addr);
    };
  }

  private handleChannelData(data: Buffer) {
    const [channel, length] = jspack.Unpack("!HH", data.slice(0, 4));

    const peerAddr = this.addrByChannel[channel];

    if (peerAddr) {
      const payload = data.slice(4, 4 + length);
      this.onDatagramReceived(payload, peerAddr);
    }
  }

  private handleSTUNMessage(data: Buffer, addr: Address) {
    try {
      const message = parseMessage(data);
      if (!message) throw new Error("not stun message");
      if (
        message.messageClass === classes.RESPONSE ||
        message.messageClass === classes.ERROR
      ) {
        const transaction = this.transactions[message.transactionIdHex];
        if (transaction) transaction.responseReceived(message, addr);
      } else if (message.messageClass === classes.REQUEST) {
        console.log("おかしい");
        this.onDatagramReceived(data, addr);
      }

      if (message.attributes.DATA) {
        const buf: Buffer = message.attributes.DATA;
        this.onDatagramReceived(buf, addr);
      }
    } catch (error) {
      console.log("parse error", data.toString());
    }
  }

  private datagramReceived(data: Buffer, addr: Address) {
    if (data.length >= 4 && isChannelData(data)) {
      this.handleChannelData(data);
      return;
    }

    this.handleSTUNMessage(data, addr);
  }

  async connect() {
    const request = new Message(methods.ALLOCATE, classes.REQUEST);
    request.attributes["LIFETIME"] = this.lifetime;
    request.attributes["REQUESTED-TRANSPORT"] = UDP_TRANSPORT;

    let response: Message;
    try {
      [response] = await this.request(request, this.server, this.integrityKey);
    } catch (error) {
      response = (error as TransactionFailed).response;
      if (response.attributes["ERROR-CODE"][0] === 401) {
        this.nonce = response.attributes.NONCE;
        this.realm = response.attributes.REALM;
        this.integrityKey = makeIntegrityKey(
          this.username,
          this.realm!,
          this.password
        );
        request.transactionId = randomTransactionId();

        try {
          [response] = await this.request(
            request,
            this.server,
            this.integrityKey
          );
        } catch (error) {
          console.log(error);
          // todo fix
        }
      }
    }

    this.relayedAddress = response.attributes["XOR-RELAYED-ADDRESS"];
    this.mappedAddress = response.attributes["XOR-MAPPED-ADDRESS"];

    this.refreshHandle = future(this.refresh());
  }

  refresh = () =>
    new PCancelable(async (r, f, onCancel) => {
      let run = true;
      onCancel(() => {
        run = false;
        f("cancel");
      });

      while (run) {
        await sleep((5 / 6) * this.lifetime * 1000);

        const request = new Message(methods.REFRESH, classes.REQUEST);
        request.attributes.LIFETIME = this.lifetime;

        await this.request(request, this.server, this.integrityKey).catch(
          // todo fix
          console.log
        );
      }
    });

  async request(
    request: Message,
    addr: Address,
    integrityKey?: Buffer
  ): Promise<[Message, Address]> {
    if (this.transactions[request.transactionIdHex]) throw new Error("exist");

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);

      request.attributes["USERNAME"] = this.username;
      request.attributes["REALM"] = this.realm;
      request.attributes["NONCE"] = this.nonce;

      request.addFingerprint();
    }

    const transaction = new Transaction(request, addr, this);
    transaction.integrityKey = integrityKey;
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async sendData(data: Buffer, addr: Address) {
    let channel = this.channelByAddr[addr.join()];
    if (!channel) {
      channel = this.channelNumber++;
      this.channelByAddr[addr.join()] = channel;
      this.addrByChannel[channel] = addr;

      await this.channelBind(channel, addr);
      console.log("bind", channel);
    }

    const header = jspack.Pack("!HH", [channel, data.length]);

    this.transport.send(
      Buffer.concat([Buffer.from(header), data]),
      this.server
    );
  }

  private async channelBind(channelNumber: number, addr: Address) {
    const request = new Message(methods.CHANNEL_BIND, classes.REQUEST);
    request.attributes["CHANNEL-NUMBER"] = channelNumber;
    request.attributes["XOR-PEER-ADDRESS"] = addr;
    try {
      const [response] = await this.request(
        request,
        this.server,
        this.integrityKey
      );
      if (response.messageMethod !== methods.CHANNEL_BIND) throw new Error();
    } catch (error) {
      console.log(error);
      // todo fix
    }
  }

  sendStun(message: Message, addr: Address) {
    this.transport.send(message.bytes, addr);
  }
}

export async function createTurnEndpoint(
  serverAddr: Address,
  username: string,
  password: string,
  lifetime = 600,
  ssl = false,
  transport = "udp"
) {
  const turnClient = new TurnClient(
    serverAddr,
    username,
    password,
    lifetime,
    new UdpTransport()
  );

  await turnClient.connectionMade();
  await turnClient.connect();
  const turnTransport = new TurnTransport(turnClient);

  return turnTransport;
}

function makeIntegrityKey(username: string, realm: string, password: string) {
  return createHash("md5")
    .update(Buffer.from([username, realm, password].join(":")))
    .digest();
}

abstract class Transport {
  onData: (data: Buffer, addr: Address) => void = () => {};
  send(data: Buffer, addr: Address) {}
}

class UdpTransport implements Transport {
  socket = createSocket("udp4");
  onData: (data: Buffer, addr: Address) => void = () => {};
  _address?: Address;
  constructor() {
    this.socket.bind();
    this.socket.on("message", (data, rInfo) => {
      this._address = [rInfo.address, rInfo.port];
      this.onData(data, this._address);
    });
  }

  send = (data: Buffer, addr: Address) => {
    this.socket.send(data, addr[1], addr[0]);
  };
}

function isChannelData(data: Buffer) {
  return (data[0] & 0xc0) == 0x40;
}
