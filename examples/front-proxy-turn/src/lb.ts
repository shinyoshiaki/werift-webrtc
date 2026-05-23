import type { Duplex } from "node:stream";
import { type TLSSocket, type TlsOptions, createServer } from "node:tls";

import type {
  ClientTransportAddress,
  PublicTurnAddress,
  RelayAttachment,
  RelayConnectionContext,
  RelayEndpoint,
  RelayEnvelope,
} from "./types";

type RandomSource = () => number;

export type FrontProxyLoadBalancerOptions = {
  host: string;
  port: number;
  publicTurnAddress: PublicTurnAddress;
  tls: TlsOptions;
  relays: RelayEndpoint[];
  random?: RandomSource;
};

export class FrontProxyLoadBalancer {
  private readonly server = createServer(this.options.tls, (socket) => {
    this.routeSecureSocket(socket);
  });
  private readonly random: RandomSource;

  constructor(private readonly options: FrontProxyLoadBalancerOptions) {
    if (options.relays.length === 0) {
      throw new Error("FrontProxyLoadBalancer requires at least one relay");
    }
    this.random = options.random ?? Math.random;
  }

  get address() {
    return this.server.address();
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close() {
    for (const socket of this.serverConnections) {
      socket.destroy();
    }
    this.serverConnections.clear();
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  selectRelay(excludeRelayId?: string) {
    const candidates = this.options.relays.filter(
      (relay) => relay.id !== excludeRelayId,
    );
    if (candidates.length === 0) {
      return this.options.relays[0];
    }
    return candidates[Math.floor(this.random() * candidates.length)];
  }

  private readonly serverConnections = new Set<TLSSocket>();

  private routeSecureSocket(socket: TLSSocket) {
    this.serverConnections.add(socket);
    socket.once("close", () => {
      this.serverConnections.delete(socket);
    });

    const context: RelayConnectionContext = {
      originalClientAddress: this.originalClientAddress(socket),
      publicTurnAddress: this.options.publicTurnAddress,
    };
    this.attachRelayEnvelope(socket, context);
  }

  routeEnvelopeForTest(stream: Duplex, context: RelayConnectionContext) {
    return this.attachRelayEnvelope(stream, context);
  }

  private originalClientAddress(socket: TLSSocket): ClientTransportAddress {
    return {
      ip: socket.remoteAddress?.split("%")[0] ?? "0.0.0.0",
      port: socket.remotePort ?? 0,
    };
  }

  private attachRelayEnvelope(stream: Duplex, context: RelayConnectionContext) {
    let attachment: RelayAttachment | undefined;

    const attach = (excludeRelayId?: string) => {
      const relay = this.selectRelay(excludeRelayId);
      const envelope: RelayEnvelope = {
        stream,
        context,
        reportRelayFailure: () => {
          if (stream.destroyed) {
            return;
          }
          attachment?.detach();
          attach(relay.id);
        },
      };
      attachment = relay.acceptEnvelope(envelope);
      return attachment;
    };

    return attach();
  }
}
