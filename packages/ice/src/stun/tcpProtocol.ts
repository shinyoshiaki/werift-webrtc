import { type AddressInfo, connect, createServer, type Socket } from "node:net";

import { Event, type Address, debug } from "../imports/common";
import type { Candidate } from "../candidate";
import type { Protocol } from "../types/model";
import { classes } from "./const";
import { type Message, parseMessage } from "./message";
import { encodeTcpFrame, splitTcpFrames } from "./tcpFrame";
import { Transaction } from "./transaction";

const log = debug("werift-ice:packages/ice/src/stun/tcpProtocol.ts");

type SocketEntry = {
  socket: Socket;
  buffer: Buffer;
  remoteAddr?: Address;
};

function socketKey(addr: Address) {
  return `${addr[0]}:${addr[1]}`;
}

function addressFromSocket(socket: Socket) {
  if (!socket.remoteAddress || !socket.remotePort) {
    return;
  }
  return [socket.remoteAddress, socket.remotePort] as Address;
}

async function waitForListening(
  server: ReturnType<typeof createServer>,
  host: string,
  port?: number,
) {
  return await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({
      host,
      port: port ?? 0,
      exclusive: true,
    });
  });
}

abstract class BaseTcpProtocol implements Protocol {
  static readonly type = "tcp";
  readonly type = BaseTcpProtocol.type;
  transactions: { [key: string]: Transaction } = {};
  localCandidate?: Candidate;
  sentMessage?: Message;
  localIp?: string;

  readonly onRequestReceived = new Event<[Message, Address, Buffer]>();
  readonly onDataReceived = new Event<[Buffer]>();

  protected readonly sockets = new Map<string, SocketEntry>();

  abstract connectionMade(...args: any[]): Promise<void>;
  protected abstract getSocket(addr: Address): Promise<SocketEntry>;

  protected rememberSocket(entry: SocketEntry) {
    const remoteAddr = entry.remoteAddr;
    if (!remoteAddr) {
      return;
    }

    this.sockets.set(socketKey(remoteAddr), entry);
  }

  protected forgetSocket(remoteAddr?: Address) {
    if (!remoteAddr) {
      return;
    }
    this.sockets.delete(socketKey(remoteAddr));
  }

  protected registerSocket(socket: Socket, remoteAddr?: Address) {
    const entry: SocketEntry = {
      socket,
      buffer: Buffer.alloc(0),
      remoteAddr,
    };

    if (remoteAddr) {
      this.rememberSocket(entry);
    }

    socket.on("data", (data) => {
      entry.buffer = Buffer.concat([entry.buffer, data]);
      const { frames, rest } = splitTcpFrames(entry.buffer);
      entry.buffer = rest;

      const socketAddr = entry.remoteAddr ?? addressFromSocket(socket);
      if (!entry.remoteAddr && socketAddr) {
        entry.remoteAddr = socketAddr;
        this.rememberSocket(entry);
      }
      if (!socketAddr) {
        return;
      }

      for (const frame of frames) {
        if (frame.length === 0) {
          continue;
        }
        this.handleFrame(frame, socketAddr);
      }
    });
    socket.on("close", () => {
      this.forgetSocket(entry.remoteAddr);
    });
    socket.on("error", (error) => {
      log("tcp socket error", error);
    });

    return entry;
  }

  private handleFrame(data: Buffer, addr: Address) {
    try {
      const message = parseMessage(data);
      if (!message) {
        this.onDataReceived.execute(data);
        return;
      }

      if (
        (message.messageClass === classes.RESPONSE ||
          message.messageClass === classes.ERROR) &&
        this.transactions[message.transactionIdHex]
      ) {
        this.transactions[message.transactionIdHex].responseReceived(message, addr);
      } else if (message.messageClass === classes.REQUEST) {
        this.onRequestReceived.execute(message, addr, data);
      }
    } catch (error) {
      log("tcp frame parse error", error);
    }
  }

  private async sendFrame(data: Buffer, addr: Address) {
    const entry = await this.getSocket(addr);
    await new Promise<void>((resolve, reject) => {
      entry.socket.write(encodeTcpFrame(data), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async sendStun(message: Message, addr: Address) {
    await this.sendFrame(message.bytes, addr);
  }

  async sendData(data: Buffer, addr: Address) {
    await this.sendFrame(data, addr);
  }

  async request(
    request: Message,
    addr: Address,
    integrityKey?: Buffer,
    retransmissions?: number,
    onRequestSent?: (attempt: number) => void,
  ) {
    if (this.transactions[request.transactionIdHex]) {
      throw new Error("already requested");
    }

    if (integrityKey) {
      request.addMessageIntegrity(integrityKey);
      request.addFingerprint();
    }

    const transaction = new Transaction(
      request,
      addr,
      this,
      retransmissions,
      onRequestSent,
    );
    this.transactions[request.transactionIdHex] = transaction;

    try {
      return await transaction.run();
    } finally {
      delete this.transactions[request.transactionIdHex];
    }
  }

  async pruneForSelection(remoteAddr?: Address) {
    for (const [key, entry] of this.sockets.entries()) {
      if (remoteAddr && key === socketKey(remoteAddr)) {
        continue;
      }
      entry.socket.destroy();
      this.sockets.delete(key);
    }
  }

  get activeSocketCount() {
    return this.sockets.size;
  }

  get address() {
    return {} as AddressInfo;
  }

  async close() {
    Object.values(this.transactions).forEach((transaction) => {
      transaction.cancel();
    });

    await this.pruneForSelection();
    this.onRequestReceived.complete();
    this.onDataReceived.complete();
  }
}

export class TcpActiveProtocol extends BaseTcpProtocol {
  private readonly pendingSockets = new Map<string, Promise<SocketEntry>>();

  async connectionMade(localIp: string) {
    this.localIp = localIp;
  }

  protected async getSocket(addr: Address) {
    const key = socketKey(addr);
    const existing = this.sockets.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.pendingSockets.get(key);
    if (pending) {
      return await pending;
    }

    const connecting = new Promise<SocketEntry>((resolve, reject) => {
      const socket = connect({
        host: addr[0],
        port: addr[1],
        localAddress: this.localIp,
      });
      const entry = this.registerSocket(socket, addr);

      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolve(entry);
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });

    this.pendingSockets.set(key, connecting);

    try {
      return await connecting;
    } finally {
      this.pendingSockets.delete(key);
    }
  }
}

export class TcpPassiveProtocol extends BaseTcpProtocol {
  private server = createServer((socket) => {
    this.registerSocket(socket, addressFromSocket(socket));
  });

  async connectionMade(localIp: string, portRange?: [number, number]) {
    this.localIp = localIp;

    if (portRange) {
      let lastError: Error | undefined;
      for (let port = portRange[0]; port <= portRange[1]; port++) {
        try {
          await waitForListening(this.server, localIp, port);
          return;
        } catch (error) {
          lastError = error as Error;
        }
      }
      throw lastError ?? new Error("tcp port not found");
    }

    await waitForListening(this.server, localIp);
  }

  protected async getSocket(addr: Address) {
    const entry = this.sockets.get(socketKey(addr));
    if (!entry) {
      throw new Error("tcp passive connection not established");
    }
    return entry;
  }

  get listeningPort() {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("tcp passive protocol is not listening");
    }
    return address.port;
  }

  override async close() {
    await super.close();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
