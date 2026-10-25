import {
  type RemoteInfo,
  type Socket,
  type SocketType,
  createSocket,
} from "node:dgram";

import type { Address } from "../../../common/src";

import {
  StunServerProtocol,
  type StunServerProtocolOptions,
  type StunTransport,
} from "../protocol";

export interface NodeStunServerOptions extends StunServerProtocolOptions {
  host?: string;
  port?: number;
  type?: SocketType;
}

export class NodeStunServer {
  readonly protocol: StunServerProtocol;
  private socket?: Socket;
  private readonly host: string;
  private readonly port: number;
  private readonly type: SocketType;

  constructor(options: NodeStunServerOptions = {}) {
    const {
      host = "0.0.0.0",
      port = 3478,
      type = "udp4",
      software = "werift-ice-server",
      ...protocolOptions
    } = options;
    this.host = host;
    this.port = port;
    this.type = type;
    this.protocol = new StunServerProtocol({
      software,
      ...protocolOptions,
    });
  }

  get address(): Address | undefined {
    if (!this.socket) {
      return undefined;
    }

    const address = this.socket.address();
    if (typeof address === "string") {
      return undefined;
    }

    return [normalizeAddress(address.address), address.port];
  }

  async listen() {
    if (this.socket) {
      return;
    }

    const socket = createSocket(this.type);
    this.socket = socket;

    socket.on("message", async (data, remoteInfo) => {
      await this.handleMessage(data, remoteInfo);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ address: this.host, port: this.port }, () => {
        socket.off("error", reject);
        resolve();
      });
    });
  }

  async close() {
    if (!this.socket) {
      return;
    }

    const socket = this.socket;
    this.socket = undefined;

    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
  }

  private async handleMessage(data: Buffer, remoteInfo: RemoteInfo) {
    if (!this.socket) {
      return;
    }

    const localAddress = this.address;
    const actions = this.protocol.handleDatagram({
      data,
      remoteAddress: [normalizeAddress(remoteInfo.address), remoteInfo.port],
      localAddress,
      transport: transportFromSocketType(this.type),
    });

    for (const action of actions) {
      if (action.type !== "send") {
        continue;
      }

      await new Promise<void>((resolve, reject) => {
        this.socket?.send(
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
  }
}

export async function createNodeStunServer(
  options: NodeStunServerOptions = {},
) {
  const server = new NodeStunServer(options);
  await server.listen();
  return server;
}

function normalizeAddress(address: string) {
  return address.split("%")[0];
}

function transportFromSocketType(type: SocketType): StunTransport {
  return type === "udp6" || type === "udp4" ? "udp" : "udp";
}
