import {
  type RemoteInfo,
  type Socket,
  type SocketType,
  createSocket,
} from "dgram";

import * as net from "node:net";
import * as tls from "node:tls";

import { type AddressInfo, type Socket as TcpSocket, connect } from "node:net";
import { debug } from "./log";
import {
  type Address,
  type InterfaceAddresses,
  findPort,
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

export class UdpTransport implements Transport {
  readonly type = "udp";
  readonly socket: Socket;
  rinfo?: Partial<Pick<RemoteInfo, "address" | "port">>;
  onData: (data: Buffer, addr: Address) => void = () => {};
  closed: boolean = false;

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
    await transport.init();
    return transport;
  }

  private async init() {
    const address = interfaceAddress(
      this.socketType,
      this.options.interfaceAddresses,
    );
    if (this.options.port) {
      this.socket.bind({ port: this.options.port, address });
    } else if (this.options.portRange) {
      const port = await findPort(
        this.options.portRange[0],
        this.options.portRange[1],
        this.socketType,
        this.options.interfaceAddresses,
      );
      this.socket.bind({ port, address });
    } else {
      this.socket.bind({ address });
    }
    await new Promise((r) => this.socket.once("listening", r));
  }

  send = async (data: Buffer, addr?: Address) => {
    if (addr && !net.isIP(addr[0])) {
      // if address is not resolved, need to use send callback to handle dns failure.
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
    } else {
      addr = addr ?? [this.rinfo?.address!, this.rinfo?.port!];
      // a preestablished remote address does not need a callback to verify dns.
      // this is faster because event loop is not used per packet.
      this.socket.send(data, addr[1], addr[0]);
    }
  };

  get address() {
    return this.socket.address();
  }

  get host() {
    return this.socket.address().address;
  }

  get port() {
    return this.socket.address().port;
  }

  close = () =>
    new Promise<void>((r) => {
      this.closed = true;
      this.socket.once("close", r);
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

  private constructor(addr: Address) {
    this.stream = new StreamTransport("tcp", () =>
      connect({ port: addr[1], host: addr[0] }),
    );
  }

  static async init(addr: Address) {
    const transport = new TcpTransport(addr);
    await transport.init();
    return transport;
  }

  private async init() {
    await this.stream.waitForConnect();
  }

  get address() {
    return this.stream.address;
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

  close = async () => {
    await this.stream.close();
  };
}

export class TlsTransport implements Transport {
  readonly type = "tls" as const;
  private readonly stream: StreamTransport;

  private constructor(addr: Address, options: TlsConnectionOptions = {}) {
    this.stream = new StreamTransport("tls", () =>
      tls.connect({
        ...options,
        host: addr[0],
        port: addr[1],
      }),
    );
  }

  static async init(addr: Address, options: TlsConnectionOptions = {}) {
    const transport = new TlsTransport(addr, options);
    await transport.init();
    return transport;
  }

  private async init() {
    await this.stream.waitForConnect();
  }

  get address() {
    return this.stream.address;
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

  constructor(
    type: StreamTransportType,
    private createClient: () => StreamSocket,
    private connectEvent: StreamConnectEvent = type === "tls"
      ? "secureConnect"
      : "connect",
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
    this.connecting = new Promise((r, f) => {
      const onConnect = () => {
        client.off("error", onConnectError);
        r();
      };
      const onConnectError = (error: Error) => {
        client.off(this.connectEvent, onConnect);
        f(error);
      };
      client.once(this.connectEvent, onConnect);
      client.once("error", onConnectError);
    });

    client.on("data", (data) => {
      const addr = [
        this.client.remoteAddress!,
        this.client.remotePort!,
      ] as Address;
      this.onData(data, addr);
    });
    client.on("end", () => {
      this.connect();
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
    this.client?.destroy();
  };
}

export interface Transport {
  type: string;
  address: AddressInfo;
  closed: boolean;
  onData: (data: Buffer, addr: Address) => void;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
}
