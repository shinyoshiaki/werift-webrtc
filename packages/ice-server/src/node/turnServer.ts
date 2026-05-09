import { randomUUID } from "crypto";
import {
  type RemoteInfo,
  type Socket,
  type SocketType,
  createSocket,
} from "node:dgram";
import {
  type AddressInfo,
  type Server as TcpServer,
  type Socket as TcpSocket,
  createServer,
} from "node:net";
import { networkInterfaces } from "node:os";

import type { Address } from "../../../common/src";

import { padTurnFrame } from "../turn/frame";
import {
  type TurnServerAction,
  TurnServerProtocol,
  type TurnServerProtocolOptions,
} from "../turn/protocol";

export interface NodeTurnServerOptions extends TurnServerProtocolOptions {
  host?: string;
  port?: number;
  relayAddress?: string;
  relayBindAddress?: string;
  credentials?: Record<string, string>;
  udp?: boolean;
  tcp?: boolean;
}

export class NodeTurnServer {
  readonly protocol: TurnServerProtocol;

  private udpSocket?: Socket;
  private tcpServer?: TcpServer;
  private readonly tcpConnections = new Map<string, TcpSocket>();
  private readonly relaySockets = new Map<string, Socket>();
  private timer?: NodeJS.Timeout;
  private readonly host: string;
  private readonly port: number;
  private readonly udpEnabled: boolean;
  private readonly tcpEnabled: boolean;
  private readonly relayAddress: string;
  private readonly relayBindAddress: string;
  private boundPort?: number;

  constructor(options: NodeTurnServerOptions = {}) {
    const {
      host = "0.0.0.0",
      port = 3478,
      relayAddress = host === "0.0.0.0" ? "127.0.0.1" : host,
      relayBindAddress = host,
      udp = true,
      tcp = true,
      credentials,
      getPassword,
      software = "werift-ice-server",
      ...protocolOptions
    } = options;

    this.host = host;
    this.port = port;
    this.udpEnabled = udp;
    this.tcpEnabled = tcp;
    this.relayAddress = relayAddress;
    this.relayBindAddress = relayBindAddress;
    this.protocol = new TurnServerProtocol({
      software,
      getPassword:
        getPassword ?? ((username, _realm) => credentials?.[username]),
      ...protocolOptions,
    });
  }

  get address(): Address | undefined {
    if (this.boundPort === undefined) {
      return undefined;
    }
    return [this.relayAddress, this.boundPort];
  }

  async listen() {
    if (this.boundPort !== undefined) {
      return;
    }

    if (!this.udpEnabled && !this.tcpEnabled) {
      throw new Error("NodeTurnServer requires udp or tcp to be enabled");
    }

    if (this.udpEnabled) {
      await this.listenUdp();
    }

    if (this.tcpEnabled) {
      await this.listenTcp(this.boundPort ?? this.port);
    }

    this.updateTimer();
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    for (const connection of this.tcpConnections.values()) {
      connection.destroy();
    }
    this.tcpConnections.clear();

    const relayClosers = [...this.relaySockets.values()].map(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.once("close", resolve);
          socket.close();
        }),
    );
    this.relaySockets.clear();

    const closers: Promise<void>[] = [];
    if (this.udpSocket) {
      const udpSocket = this.udpSocket;
      this.udpSocket = undefined;
      closers.push(
        new Promise<void>((resolve) => {
          udpSocket.once("close", resolve);
          udpSocket.close();
        }),
      );
    }

    if (this.tcpServer) {
      const tcpServer = this.tcpServer;
      this.tcpServer = undefined;
      closers.push(
        new Promise<void>((resolve) => {
          tcpServer.close(() => resolve());
        }),
      );
    }

    this.boundPort = undefined;
    await Promise.all([...relayClosers, ...closers]);
  }

  private async listenUdp() {
    const socket = createSocket(this.socketType(this.host));
    this.udpSocket = socket;
    socket.on("message", async (data, remoteInfo) => {
      await this.executeActions(
        this.protocol.handleClientDatagram({
          clientId: udpClientId(remoteInfo),
          data,
          remoteAddress: [
            normalizeAddress(remoteInfo.address),
            remoteInfo.port,
          ],
          localAddress: this.address,
          transport: "udp",
        }),
      );
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ address: this.host, port: this.port }, () => {
        socket.off("error", reject);
        const address = socket.address();
        if (typeof address === "string") {
          reject(new Error("Expected UDP address info"));
          return;
        }
        this.boundPort = address.port;
        resolve();
      });
    });
  }

  private async listenTcp(port: number) {
    const server = createServer((socket) => {
      const clientId = randomUUID();
      this.tcpConnections.set(clientId, socket);
      socket.on("data", async (data) => {
        await this.executeActions(
          this.protocol.handleTcpChunk({
            clientId,
            data,
            remoteAddress: [
              normalizeAddress(socket.remoteAddress ?? ""),
              socket.remotePort ?? 0,
            ],
            localAddress: this.address,
          }),
        );
      });
      socket.on("close", async () => {
        this.tcpConnections.delete(clientId);
        await this.executeActions(
          this.protocol.handleClientClosed({ clientId }),
        );
      });
      socket.on("error", () => {});
    });
    this.tcpServer = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Expected TCP address info"));
          return;
        }
        this.boundPort = address.port;
        resolve();
      });
    });
  }

  private async executeActions(actions: TurnServerAction[]) {
    for (const action of actions) {
      switch (action.type) {
        case "send-client":
          await this.sendClient(action);
          break;
        case "send-relay":
          await this.sendRelay(action);
          break;
        case "bind-relay":
          await this.bindRelay(action.allocationId, action.relayId);
          break;
        case "close-relay":
          await this.closeRelay(action.relayId);
          break;
        case "close-client":
          this.closeClient(action.clientId);
          break;
        default:
          break;
      }
    }

    this.updateTimer();
  }

  private async sendClient(
    action: Extract<TurnServerAction, { type: "send-client" }>,
  ) {
    if (action.transport === "tcp") {
      const socket = this.tcpConnections.get(action.clientId);
      if (!socket || socket.destroyed) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        socket.write(padTurnFrame(action.data), (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      return;
    }

    if (!this.udpSocket) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.udpSocket?.send(
        padTurnFrame(action.data),
        action.remoteAddress[1],
        action.remoteAddress[0],
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  }

  private async sendRelay(
    action: Extract<TurnServerAction, { type: "send-relay" }>,
  ) {
    const relaySocket = this.relaySockets.get(action.relayId);
    if (!relaySocket) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      relaySocket.send(
        action.data,
        action.remoteAddress[1],
        action.remoteAddress[0],
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  }

  private async bindRelay(allocationId: string, relayId: string) {
    const socket = createSocket(this.socketType(this.relayBindAddress));
    this.relaySockets.set(relayId, socket);
    socket.on("message", async (data, remoteInfo) => {
      const localAddress = socket.address();
      if (typeof localAddress === "string") {
        return;
      }

      await this.executeActions(
        this.protocol.handleRelayPacket({
          relayId,
          data,
          remoteAddress: this.normalizeRelayRemoteAddress(remoteInfo),
          localAddress: [this.relayAddress, localAddress.port],
        }),
      );
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address: this.relayBindAddress, port: 0 }, () => {
          socket.off("error", reject);
          resolve();
        });
      });

      const address = socket.address();
      if (typeof address === "string") {
        throw new Error("Expected relay UDP address info");
      }

      await this.executeActions(
        this.protocol.handleRelayBound({
          allocationId,
          relayId,
          relayedAddress: [this.relayAddress, address.port],
        }),
      );
    } catch (error) {
      this.relaySockets.delete(relayId);
      try {
        socket.close();
      } catch {}

      await this.executeActions(
        this.protocol.handleRelayBindFailure({
          allocationId,
        }),
      );
    }
  }

  private async closeRelay(relayId: string) {
    const relaySocket = this.relaySockets.get(relayId);
    if (!relaySocket) {
      return;
    }

    this.relaySockets.delete(relayId);
    await new Promise<void>((resolve) => {
      relaySocket.once("close", resolve);
      relaySocket.close();
    });
  }

  private closeClient(clientId: string) {
    const socket = this.tcpConnections.get(clientId);
    if (!socket || socket.destroyed) {
      return;
    }
    socket.destroy();
  }

  private updateTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    const nextTimeoutAt = this.protocol.nextTimeoutAt;
    if (nextTimeoutAt === undefined) {
      return;
    }

    this.timer = setTimeout(
      async () => {
        this.timer = undefined;
        await this.executeActions(this.protocol.handleTimer());
      },
      Math.max(0, nextTimeoutAt - Date.now()),
    );
  }

  private normalizeRelayRemoteAddress(
    remoteInfo: Pick<RemoteInfo, "address" | "port">,
  ): Address {
    const remoteAddress = normalizeAddress(remoteInfo.address);
    for (const relaySocket of this.relaySockets.values()) {
      const address = relaySocket.address();
      if (typeof address === "string") {
        continue;
      }
      if (this.isRelaySocketAddress(address, remoteAddress, remoteInfo.port)) {
        return [this.relayAddress, remoteInfo.port];
      }
    }

    return [remoteAddress, remoteInfo.port];
  }

  private isRelaySocketAddress(
    address: AddressInfo,
    remoteAddress: string,
    remotePort: number,
  ) {
    if (address.port !== remotePort) {
      return false;
    }

    const boundAddress = normalizeAddress(address.address);
    return (
      boundAddress === remoteAddress ||
      ((isWildcardAddress(boundAddress) ||
        this.isLocalInterfaceAddress(boundAddress)) &&
        this.isLocalInterfaceAddress(remoteAddress))
    );
  }

  private isLocalInterfaceAddress(address: string) {
    if (address === this.relayAddress) {
      return true;
    }

    return Object.values(networkInterfaces())
      .flat()
      .some(
        (candidate) =>
          candidate && normalizeAddress(candidate.address) === address,
      );
  }

  private socketType(address: string): SocketType {
    return address.includes(":") ? "udp6" : "udp4";
  }
}

export async function createNodeTurnServer(
  options: NodeTurnServerOptions = {},
) {
  const server = new NodeTurnServer(options);
  await server.listen();
  return server;
}

function normalizeAddress(address: string) {
  return address.split("%")[0];
}

function isWildcardAddress(address: string) {
  return address === "0.0.0.0" || address === "::";
}

function udpClientId(remoteInfo: Pick<RemoteInfo, "address" | "port">) {
  return `udp:${normalizeAddress(remoteInfo.address)}:${remoteInfo.port}`;
}
