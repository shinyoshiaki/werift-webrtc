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
import {
  type TLSSocket,
  type TlsOptions,
  type Server as TlsServer,
  createServer as createTlsServer,
} from "node:tls";

import type { Address } from "../../../common/src";

import { padTurnFrame } from "../turn/frame";
import {
  type TurnServerAction,
  TurnServerProtocol,
  type TurnServerProtocolOptions,
} from "../turn/protocol";

export interface NodeTurnServerTlsOptions extends TlsOptions {
  external?: boolean;
  port?: number;
}

export interface NodeTurnServerAttachTlsSocketOptions {
  initialData?: Buffer;
  localAddress?: Address;
}

export interface NodeTurnServerOptions extends TurnServerProtocolOptions {
  host?: string;
  port?: number;
  relayAddress?: string;
  relayBindAddress?: string;
  credentials?: Record<string, string>;
  udp?: boolean;
  tcp?: boolean;
  tls?: NodeTurnServerTlsOptions;
}

export class NodeTurnServer {
  readonly protocol: TurnServerProtocol;

  private udpSocket?: Socket;
  private tcpServer?: TcpServer;
  private tlsServer?: TlsServer;
  private readonly tcpConnections = new Map<string, TcpSocket>();
  private readonly tlsConnections = new Map<string, TLSSocket>();
  private readonly relaySockets = new Map<string, Socket>();
  private timer?: NodeJS.Timeout;
  private readonly host: string;
  private readonly port: number;
  private readonly udpEnabled: boolean;
  private readonly tcpEnabled: boolean;
  private readonly tlsEnabled: boolean;
  private readonly tlsExternal: boolean;
  private readonly tlsOptions?: NodeTurnServerTlsOptions;
  private readonly tlsPort: number;
  private readonly relayAddress: string;
  private readonly relayBindAddress: string;
  private boundPort?: number;
  private boundTlsPort?: number;

  constructor(options: NodeTurnServerOptions = {}) {
    const {
      host = "0.0.0.0",
      port = 3478,
      relayAddress = host === "0.0.0.0" ? "127.0.0.1" : host,
      relayBindAddress = host,
      udp = true,
      tcp = true,
      credentials,
      tls,
      getPassword,
      software = "werift-ice-server",
      ...protocolOptions
    } = options;

    this.host = host;
    this.port = port;
    this.udpEnabled = udp;
    this.tcpEnabled = tcp;
    this.tlsEnabled = tls !== undefined;
    this.tlsExternal = Boolean(tls?.external);
    this.tlsOptions = tls;
    this.tlsPort = tls?.port ?? (port === 0 ? 0 : 5349);
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

  get tlsAddress(): Address | undefined {
    if (this.boundTlsPort === undefined) {
      return undefined;
    }
    return [this.relayAddress, this.boundTlsPort];
  }

  async listen() {
    if (this.boundPort !== undefined || this.boundTlsPort !== undefined) {
      return;
    }

    if (!this.udpEnabled && !this.tcpEnabled && !this.tlsEnabled) {
      throw new Error("NodeTurnServer requires udp, tcp, or tls to be enabled");
    }

    if (
      this.tcpEnabled &&
      this.tlsEnabled &&
      !this.tlsExternal &&
      this.tlsPort !== 0 &&
      this.tlsPort === this.port
    ) {
      throw new Error(
        "NodeTurnServer cannot share the same port for tcp and tls",
      );
    }

    if (
      this.tlsEnabled &&
      !this.tlsExternal &&
      (!this.tlsOptions?.key || !this.tlsOptions?.cert)
    ) {
      throw new Error("NodeTurnServer tls requires both key and cert");
    }

    if (this.udpEnabled) {
      await this.listenUdp();
    }

    if (this.tcpEnabled) {
      await this.listenTcp(this.boundPort ?? this.port);
    }

    if (this.tlsEnabled) {
      if (this.tlsExternal) {
        if (this.tlsPort !== 0) {
          this.boundTlsPort = this.tlsPort;
        }
      } else {
        await this.listenTls(this.tlsPort);
      }
    }

    this.updateTimer();
  }

  attachTlsSocket(
    socket: TLSSocket,
    options: NodeTurnServerAttachTlsSocketOptions = {},
  ) {
    if (!this.tlsEnabled) {
      throw new Error(
        "NodeTurnServer tls must be enabled before attaching sockets",
      );
    }

    this.handleStreamConnection(socket, "tls", options);
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

    for (const connection of this.tlsConnections.values()) {
      connection.destroy();
    }
    this.tlsConnections.clear();

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

    if (this.tlsServer) {
      const tlsServer = this.tlsServer;
      this.tlsServer = undefined;
      closers.push(
        new Promise<void>((resolve) => {
          tlsServer.close(() => resolve());
        }),
      );
    }

    this.boundPort = undefined;
    this.boundTlsPort = undefined;
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
      this.handleStreamConnection(socket, "tcp");
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

  private async listenTls(port: number) {
    const server = createTlsServer(this.tlsOptions!, (socket) => {
      this.handleStreamConnection(socket, "tls");
    });
    this.tlsServer = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.off("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Expected TLS address info"));
          return;
        }
        this.boundTlsPort = address.port;
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
    if (action.transport === "tcp" || action.transport === "tls") {
      const socket = this.getStreamClient(action.transport, action.clientId);
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
      }).catch(async (error) => {
        if (!isClosedTcpWriteError(error)) {
          throw error;
        }

        await this.executeActions(
          this.protocol.handleClientClosed({ clientId: action.clientId }),
        );
      });
      return;
    }

    if (action.transport !== "udp") {
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
    if (socket && !socket.destroyed) {
      socket.destroy();
      return;
    }

    const tlsSocket = this.tlsConnections.get(clientId);
    if (tlsSocket && !tlsSocket.destroyed) {
      tlsSocket.destroy();
    }
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

  private handleStreamConnection(
    socket: TcpSocket,
    transport: "tcp",
    options?: NodeTurnServerAttachTlsSocketOptions,
  ): void;
  private handleStreamConnection(
    socket: TLSSocket,
    transport: "tls",
    options?: NodeTurnServerAttachTlsSocketOptions,
  ): void;
  private handleStreamConnection(
    socket: TcpSocket | TLSSocket,
    transport: "tcp" | "tls",
    options: NodeTurnServerAttachTlsSocketOptions = {},
  ) {
    const clientId = randomUUID();
    const localAddress =
      options.localAddress ?? this.resolveStreamLocalAddress(socket, transport);
    if (transport === "tcp") {
      this.tcpConnections.set(clientId, socket as TcpSocket);
    } else {
      this.tlsConnections.set(clientId, socket as TLSSocket);
    }
    const handleData = async (data: Buffer) => {
      await this.executeActions(
        this.protocol.handleTcpChunk({
          clientId,
          data,
          remoteAddress: [
            normalizeAddress(socket.remoteAddress ?? ""),
            socket.remotePort ?? 0,
          ],
          localAddress,
          transport,
        }),
      );
    };
    socket.on("data", (data) => {
      void handleData(data);
    });
    socket.on("close", async () => {
      if (transport === "tcp") {
        this.tcpConnections.delete(clientId);
      } else {
        this.tlsConnections.delete(clientId);
      }
      await this.executeActions(this.protocol.handleClientClosed({ clientId }));
    });
    socket.on("error", () => {});

    if (options.initialData?.length) {
      void handleData(options.initialData);
    }
  }

  private getStreamClient(transport: "tcp" | "tls", clientId: string) {
    return transport === "tcp"
      ? this.tcpConnections.get(clientId)
      : this.tlsConnections.get(clientId);
  }

  private resolveStreamLocalAddress(
    socket: TcpSocket | TLSSocket,
    transport: "tcp" | "tls",
  ) {
    if (socket.localAddress && socket.localPort) {
      return [
        normalizeAddress(socket.localAddress),
        socket.localPort,
      ] as Address;
    }

    return transport === "tcp" ? this.address : this.tlsAddress;
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

function isClosedTcpWriteError(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  return (
    code === "ECONNRESET" || code === "EPIPE" || code === "ERR_STREAM_DESTROYED"
  );
}

function udpClientId(remoteInfo: Pick<RemoteInfo, "address" | "port">) {
  return `udp:${normalizeAddress(remoteInfo.address)}:${remoteInfo.port}`;
}
