import {
  type RemoteInfo,
  type Socket,
  type SocketType,
  createSocket,
} from "dgram";

import { type AddressInfo, type Socket as TcpSocket, connect } from "net";
import { debug } from "./log";
import {
  type Address,
  type InterfaceAddresses,
  findPort,
  interfaceAddress,
  normalizeFamilyNodeV18,
} from "./network";

const log = debug("werift-ice:packages/ice/src/transport.ts");

export class UdpTransport implements Transport {
  readonly type = "udp";
  readonly socket: Socket;
  rinfo?: Partial<Pick<RemoteInfo, "address" | "port">>;
  onData: (data: Buffer, addr: Address) => void = () => {};

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

  send = (data: Buffer, addr?: Address) =>
    new Promise<void>((r, f) => {
      addr = addr ?? [this.rinfo?.address!, this.rinfo?.port!];
      this.socket.send(data, addr[1], addr[0], (error) => {
        if (error) {
          log("send error", addr, data);
          f(error);
        } else {
          r();
        }
      });
    });

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
      this.socket.once("close", r);
      try {
        this.socket.close();
      } catch (error) {
        r();
      }
    });
}

export class TcpTransport implements Transport {
  readonly type = "tcp";
  private connecting!: Promise<void>;
  private client!: TcpSocket;
  onData: (data: Buffer, addr: Address) => void = () => {};
  closed = false;

  private constructor(private addr: Address) {
    this.connect();
  }

  private connect() {
    if (this.closed) {
      return;
    }

    if (this.client) {
      this.client.destroy();
    }
    this.connecting = new Promise((r, f) => {
      try {
        this.client = connect({ port: this.addr[1], host: this.addr[0] }, r);
      } catch (error) {
        f(error);
      }
    });

    this.client.on("data", (data) => {
      const addr = [
        this.client.remoteAddress!,
        this.client.remotePort!,
      ] as Address;
      this.onData(data, addr);
    });
    this.client.on("end", () => {
      this.connect();
    });
    this.client.on("error", (error) => {
      console.log("error", error);
    });
  }

  private async init() {
    await this.connecting;
  }

  static async init(addr: Address) {
    const transport = new TcpTransport(addr);
    await transport.init();
    return transport;
  }

  get address() {
    return {} as AddressInfo;
  }

  send = async (data: Buffer, addr?: Address) => {
    await this.connecting;
    this.client.write(data, (err) => {
      if (err) {
        console.log("err", err);
      }
    });
  };

  close = async () => {
    this.closed = true;
    this.client.destroy();
  };
}

export interface Transport {
  type: string;
  address: AddressInfo;
  onData: (data: Buffer, addr: Address) => void;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
}
