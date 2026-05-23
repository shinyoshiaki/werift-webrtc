import { randomUUID } from "node:crypto";
import {
  type RemoteInfo,
  type Socket,
  type SocketType,
  createSocket,
} from "node:dgram";

import type { Address } from "../../../packages/common/src";
import {
  type TurnServerAction,
  TurnServerProtocol,
  type TurnServerProtocolOptions,
  padTurnFrame,
} from "../../../packages/ice-server/src";
import {
  type ClientTransportKey,
  type RelayConnectionContext,
  type RelayToTurnFrame,
  addressTuple,
  publicAddressTuple,
} from "./types";

export type RelaySink = {
  write(data: Buffer): Promise<void> | void;
  close(): Promise<void> | void;
};

export type BackendTurnServerOptions = TurnServerProtocolOptions & {
  id: string;
  relayAddress: string;
  relayBindAddress: string;
};

export class BackendTurnServer {
  readonly protocol: TurnServerProtocol;
  private readonly relaySinks = new Map<ClientTransportKey, RelaySink>();
  private readonly relaySockets = new Map<string, Socket>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: BackendTurnServerOptions) {
    this.protocol = new TurnServerProtocol({
      ...options,
      software: options.software ?? `werift-front-proxy-turn-${options.id}`,
    });
  }

  get id() {
    return this.options.id;
  }

  attachRelay(clientTransportKey: ClientTransportKey, sink: RelaySink) {
    this.relaySinks.set(clientTransportKey, sink);
  }

  detachRelay(clientTransportKey: ClientTransportKey, sink: RelaySink) {
    if (this.relaySinks.get(clientTransportKey) === sink) {
      this.relaySinks.delete(clientTransportKey);
    }
  }

  async handleFrame(frame: RelayToTurnFrame, context: RelayConnectionContext) {
    await this.executeActions(
      this.protocol.handleTcpChunk({
        clientId: frame.clientTransportKey,
        data: frame.payload,
        remoteAddress: addressTuple(context.originalClientAddress),
        localAddress: publicAddressTuple(context.publicTurnAddress),
        transport: "tls",
      }),
    );
  }

  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    for (const socket of this.relaySockets.values()) {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    }
    this.relaySockets.clear();

    for (const sink of this.relaySinks.values()) {
      await sink.close();
    }
    this.relaySinks.clear();
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
          await this.relaySinks.get(action.clientId)?.close();
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
    const sink = this.relaySinks.get(action.clientId);
    if (!sink) {
      return;
    }
    await sink.write(padTurnFrame(action.data));
  }

  private async sendRelay(
    action: Extract<TurnServerAction, { type: "send-relay" }>,
  ) {
    const socket = this.relaySockets.get(action.relayId);
    if (!socket) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      socket.send(
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
    const socket = createSocket(this.socketType(this.options.relayBindAddress));
    this.relaySockets.set(relayId, socket);
    socket.on("message", (data, remoteInfo) => {
      void this.executeActions(
        this.protocol.handleRelayPacket({
          relayId,
          data,
          remoteAddress: this.normalizeRemoteAddress(remoteInfo),
          localAddress: this.relayLocalAddress(socket),
        }),
      );
    });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address: this.options.relayBindAddress, port: 0 }, () => {
          socket.off("error", reject);
          resolve();
        });
      });

      await this.executeActions(
        this.protocol.handleRelayBound({
          allocationId,
          relayId,
          relayedAddress: this.relayLocalAddress(socket),
        }),
      );
    } catch (error) {
      this.relaySockets.delete(relayId);
      socket.close();
      await this.executeActions(
        this.protocol.handleRelayBindFailure({
          allocationId,
          reason: error instanceof Error ? error.message : "relay bind failed",
        }),
      );
    }
  }

  private async closeRelay(relayId: string) {
    const socket = this.relaySockets.get(relayId);
    if (!socket) {
      return;
    }
    this.relaySockets.delete(relayId);
    await new Promise<void>((resolve) => {
      socket.once("close", resolve);
      socket.close();
    });
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
      () => {
        this.timer = undefined;
        void this.executeActions(this.protocol.handleTimer());
      },
      Math.max(0, nextTimeoutAt - Date.now()),
    );
  }

  private relayLocalAddress(socket: Socket): Address {
    const address = socket.address();
    if (typeof address === "string") {
      throw new Error("expected UDP relay address info");
    }
    return [this.options.relayAddress, address.port];
  }

  private normalizeRemoteAddress(
    remoteInfo: Pick<RemoteInfo, "address" | "port">,
  ) {
    return [remoteInfo.address.split("%")[0], remoteInfo.port] as Address;
  }

  private socketType(address: string): SocketType {
    return address.includes(":") ? "udp6" : "udp4";
  }
}

export function createBackendTurnServer(
  options: Omit<BackendTurnServerOptions, "id"> & { id?: string },
) {
  return new BackendTurnServer({
    ...options,
    id: options.id ?? `backend-${randomUUID()}`,
  });
}
