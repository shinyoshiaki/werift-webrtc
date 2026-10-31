import * as net from "node:net";
import { type AddressInfo, connect, type Socket as TcpSocket } from "node:net";
import * as tls from "node:tls";
import {
  createSocket,
  type RemoteInfo,
  type Socket,
  type SocketType,
} from "dgram";
import { Event } from "./event";
import { debug } from "./log";
import {
  type Address,
  findPort,
  type InterfaceAddresses,
  interfaceAddress,
  normalizeFamilyNodeV18,
} from "./network";

const log = debug("werift-ice:packages/ice/src/transport.ts");

type StreamTransportType = "tcp" | "tls";
type StreamSocket = TcpSocket | tls.TLSSocket;
type StreamConnectEvent = "connect" | "secureConnect";

export type TlsConnectionOptions = Omit<
  tls.ConnectionOptions,
  "host" | "port" | "socket"
>;

export interface StreamTransportOptions {
  /** Maximum time to wait for TCP/TLS connection establishment, in milliseconds. */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

export class UdpTransport implements Transport {
  readonly type = "udp";
  readonly socket: Socket;
  rinfo?: Partial<Pick<RemoteInfo, "address" | "port">>;
  onData: (data: Buffer, addr: Address) => void = () => {};
  /**
   * Runtime socket errors (e.g. an asynchronous ECONNREFUSED from an ICMP
   * port unreachable). The socket stays open; bind errors reject init()
   * instead of being emitted here.
   */
  readonly onError = new Event<[Error]>();
  closed: boolean = false;
  private listening = false;

  private constructor(
    private socketType: SocketType,
    private options: {
      portRange?: [number, number];
      interfaceAddresses?: InterfaceAddresses;
      port?: number;
    } = {},
  ) {
    this.socket = createSocket(socketType);
    this.socket.on("message", (data, info) => {
      if (normalizeFamilyNodeV18(info.family) === 6) {
        [info.address] = info.address.split("%"); // example fe80::1d3a:8751:4ffd:eb80%wlp82s0
      }
      this.rinfo = info;
      try {
        this.onData(data, [info.address, info.port]);
      } catch (error) {
        log("onData error", error);
      }
    });
    // The socket must always own its error event: an unhandled dgram error
    // would become a process-level uncaught exception.
    this.socket.on("error", (error) => {
      log("udp socket error", error);
      // bind errors are handled by init(); errors after close are stale.
      if (this.closed || !this.listening) {
        return;
      }
      try {
        this.onError.execute(error);
      } catch (handlerError) {
        log("onError handler error", handlerError);
      }
    });
  }

  static async init(
    type: SocketType,
    options: {
      portRange?: [number, number];
      port?: number;
      interfaceAddresses?: InterfaceAddresses;
    } = {},
  ) {
    const transport = new UdpTransport(type, options);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private async init() {
    const address = interfaceAddress(
      this.socketType,
      this.options.interfaceAddresses,
    );
    const port = this.options.port
      ? this.options.port
      : this.options.portRange
        ? await findPort(
            this.options.portRange[0],
            this.options.portRange[1],
            this.socketType,
            this.options.interfaceAddresses,
          )
        : undefined;
    if (this.closed) {
      throw new Error("udp transport closed");
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.socket.off("listening", onListening);
        this.socket.off("error", onBindError);
        this.socket.off("close", onClose);
        error ? reject(error) : resolve();
      };
      const onListening = () => {
        this.listening = true;
        settle();
      };
      const onBindError = (error: Error) => {
        settle(error);
      };
      const onClose = () => {
        settle(new Error("udp transport closed"));
      };
      this.socket.once("listening", onListening);
      this.socket.once("error", onBindError);
      this.socket.once("close", onClose);
      try {
        if (port === undefined) {
          this.socket.bind({ address });
        } else {
          this.socket.bind({ port, address });
        }
      } catch (error) {
        settle(error as Error);
      }
    });
  }

  send = async (data: Buffer, addr?: Address) => {
    if (addr && !net.isIP(addr[0])) {
      // Unresolved hostname: must wait for the send callback (DNS failure).
      return this.sendAndWait(data, addr);
    }
    addr = addr ?? [this.rinfo?.address!, this.rinfo?.port!];
    // Resolved IP: fire-and-forget so the event loop is not used per packet.
    this.socket.send(data, addr[1], addr[0]);
  };

  /**
   * Wait until the kernel accepts the datagram. Use only when a later
   * socket.close() must not drop this packet (DTLS close_notify).
   */
  sendAndWait = (data: Buffer, addr?: Address) => {
    addr = addr ?? [this.rinfo?.address!, this.rinfo?.port!];
    return new Promise<void>((r, f) => {
      this.socket.send(data, addr![1], addr![0], (error) => {
        if (error) {
          log("send error", addr, data);
          f(error);
        } else {
          r();
        }
      });
    });
  };

  get address() {
    return this.socket.address();
  }

  /** IP family of the bound socket: 4 for udp4, 6 for udp6. */
  get addressFamily(): IpAddressFamily {
    return this.socketType === "udp6" ? 6 : 4;
  }

  get host() {
    return this.socket.address().address;
  }

  get port() {
    return this.socket.address().port;
  }

  close = () =>
    new Promise<void>((r) => {
      if (this.closed) {
        r();
        return;
      }
      this.closed = true;
      this.socket.once("close", r);
      // A subscriber's completion handler must not prevent the socket from
      // being released; otherwise the port stays bound forever.
      try {
        this.onError.complete();
      } catch (error) {
        log("onError complete error", error);
      }
      try {
        this.socket.close();
      } catch (error) {
        r();
      }
    });
}

export class TcpTransport implements Transport {
  readonly type = "tcp" as const;
  private readonly stream: StreamTransport;

  private constructor(addr: Address, options: StreamTransportOptions = {}) {
    this.stream = new StreamTransport(
      "tcp",
      () => connect({ port: addr[1], host: addr[0] }),
      undefined,
      options.connectTimeoutMs,
    );
  }

  static async init(addr: Address, options: StreamTransportOptions = {}) {
    const transport = new TcpTransport(addr, options);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private async init() {
    await this.stream.waitForConnect();
  }

  get address() {
    return this.stream.address;
  }

  get remoteAddress() {
    return this.stream.remoteAddress;
  }

  get closed() {
    return this.stream.closed;
  }

  get onData() {
    return this.stream.onData;
  }

  set onData(handler: (data: Buffer, addr: Address) => void) {
    this.stream.onData = handler;
  }

  send = async (data: Buffer, addr?: Address) => {
    await this.stream.send(data, addr);
  };

  sendAndWait = async (data: Buffer, addr?: Address) => {
    await this.stream.send(data, addr);
  };

  close = async () => {
    await this.stream.close();
  };
}

export class TlsTransport implements Transport {
  readonly type = "tls" as const;
  private readonly stream: StreamTransport;

  private constructor(
    addr: Address,
    options: TlsConnectionOptions = {},
    streamOptions: StreamTransportOptions = {},
  ) {
    this.stream = new StreamTransport(
      "tls",
      () =>
        tls.connect({
          ...options,
          host: addr[0],
          port: addr[1],
        }),
      undefined,
      streamOptions.connectTimeoutMs,
    );
  }

  static async init(
    addr: Address,
    options: TlsConnectionOptions = {},
    streamOptions: StreamTransportOptions = {},
  ) {
    const transport = new TlsTransport(addr, options, streamOptions);
    try {
      await transport.init();
      return transport;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  private async init() {
    await this.stream.waitForConnect();
  }

  get address() {
    return this.stream.address;
  }

  get remoteAddress() {
    return this.stream.remoteAddress;
  }

  get closed() {
    return this.stream.closed;
  }

  get onData() {
    return this.stream.onData;
  }

  set onData(handler: (data: Buffer, addr: Address) => void) {
    this.stream.onData = handler;
  }

  send = async (data: Buffer, addr?: Address) => {
    await this.stream.send(data, addr);
  };

  sendAndWait = async (data: Buffer, addr?: Address) => {
    await this.stream.send(data, addr);
  };

  close = async () => {
    await this.stream.close();
  };
}

class StreamTransport implements Transport {
  readonly type: StreamTransportType;
  private connecting!: Promise<void>;
  private client!: StreamSocket;
  onData: (data: Buffer, addr: Address) => void = () => {};
  closed = false;
  private rejectConnecting?: (error: Error) => void;

  constructor(
    type: StreamTransportType,
    private createClient: () => StreamSocket,
    private connectEvent: StreamConnectEvent = type === "tls"
      ? "secureConnect"
      : "connect",
    private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  ) {
    this.type = type;
    this.connect();
  }

  private connect() {
    if (this.closed) {
      return;
    }

    if (this.client) {
      this.client.destroy();
    }
    const client = this.createClient();
    this.client = client;
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.off(this.connectEvent, onConnect);
        client.off("error", onConnectError);
        this.rejectConnecting = undefined;
        error ? reject(error) : resolve();
      };
      const onConnect = () => {
        settle();
      };
      const onConnectError = (error: Error) => {
        this.closed = true;
        settle(error);
        client.destroy();
      };
      const timer = setTimeout(() => {
        this.closed = true;
        settle(
          new Error(
            `${this.type} connect timed out after ${this.connectTimeoutMs}ms`,
          ),
        );
        client.destroy();
      }, this.connectTimeoutMs);
      this.rejectConnecting = (error) => settle(error);
      client.once(this.connectEvent, onConnect);
      client.once("error", onConnectError);
    });

    client.on("data", (data) => {
      this.onData(data, this.remoteAddress!);
    });
    client.on("error", (error) => {
      log(`${this.type} transport error`, error);
    });
  }

  async waitForConnect() {
    await this.connecting;
  }

  get address() {
    return {} as AddressInfo;
  }

  /** The peer the stream is connected to, once connected. */
  get remoteAddress(): Address | undefined {
    const { remoteAddress, remotePort } = this.client;
    if (!remoteAddress || !remotePort) {
      return undefined;
    }
    return [stripZoneId(remoteAddress), remotePort];
  }

  send = async (data: Buffer, addr?: Address) => {
    void addr;
    await this.connecting;
    await new Promise<void>((resolve, reject) => {
      this.client.write(data, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  };

  close = async () => {
    this.closed = true;
    this.rejectConnecting?.(new Error(`${this.type} transport closed`));
    this.client?.destroy();
  };
}

/**
 * Optional per-datagram RX metadata threaded through {@link Transport.onData}.
 * `rxGeneration` is an opaque carrier generation token (e.g. ICE generation):
 * the DTLS engine drops queued datagrams whose accept-time generation no
 * longer matches at queue-execution time (ICE restart race).
 */
export interface DatagramRxMeta {
  rxGeneration?: number;
}

/** Strip an IPv6 zone identifier, e.g. fe80::1%eth0 -> fe80::1. */
function stripZoneId(address: string) {
  return address.split("%")[0];
}

export type IpAddressFamily = 4 | 6;

export interface Transport {
  type: string;
  address: AddressInfo;
  closed: boolean;
  onData: (data: Buffer, addr: Address, meta?: DatagramRxMeta) => void;
  /**
   * Runtime transport errors that do not close the transport. Optional so
   * custom transports need not implement it; the built-in UDP transport does.
   */
  onError?: Event<[Error]>;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  /**
   * Optional flush: wait until the datagram is accepted by the kernel.
   * Hot-path {@link send} must stay fire-and-forget for resolved IP peers.
   * DTLS close_notify uses this so a following socket.close() cannot drop it.
   */
  sendAndWait?: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
  /**
   * When true, the transport path is already peer-authenticated (e.g. ICE).
   * DTLS 1.2 may treat protected records as association-authenticated even
   * without a UDP 5-tuple pin (ICE does not expose source address on RX).
   */
  peerAuthenticated?: boolean;
  /**
   * IP family of a datagram socket. A datagram transport can only reach
   * addresses of this family. Built-in UDP transports always set it; a custom
   * transport that leaves it unset gets no family preference.
   */
  addressFamily?: IpAddressFamily;
  /**
   * The peer a connected (stream) transport is talking to. Responses arrive
   * from this address. Built-in TCP/TLS transports set it once connected.
   */
  remoteAddress?: Address;
}

/** Flush one datagram when the transport supports it; else {@link Transport.send}. */
export function flushTransportSend(
  transport: Transport,
  data: Buffer,
  addr?: Address,
): Promise<void> {
  if (transport.sendAndWait) {
    return transport.sendAndWait(data, addr);
  }
  return transport.send(data, addr);
}
