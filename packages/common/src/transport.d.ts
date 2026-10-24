import * as net from "node:net";
import { type AddressInfo } from "node:net";
import * as tls from "node:tls";
import { type RemoteInfo, type Socket, type SocketType } from "dgram";
import { type Address, type InterfaceAddresses } from "./network";
export type TlsConnectionOptions = Omit<
  tls.ConnectionOptions,
  "host" | "port" | "socket"
>;
export interface StreamTransportOptions {
  /** Maximum time to wait for TCP/TLS connection establishment, in milliseconds. */
  connectTimeoutMs?: number;
}
export declare class UdpTransport implements Transport {
  private socketType;
  private options;
  readonly type = "udp";
  readonly socket: Socket;
  rinfo?: Partial<Pick<RemoteInfo, "address" | "port">>;
  onData: (data: Buffer, addr: Address) => void;
  closed: boolean;
  private constructor();
  static init(
    type: SocketType,
    options?: {
      portRange?: [number, number];
      port?: number;
      interfaceAddresses?: InterfaceAddresses;
    },
  ): Promise<UdpTransport>;
  private init;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  get address(): net.AddressInfo;
  /** IP family of the bound socket: 4 for udp4, 6 for udp6. */
  get addressFamily(): IpAddressFamily;
  get host(): string;
  get port(): number;
  close: () => Promise<void>;
}
export declare class TcpTransport implements Transport {
  readonly type: "tcp";
  private readonly stream;
  private constructor();
  static init(
    addr: Address,
    options?: StreamTransportOptions,
  ): Promise<TcpTransport>;
  private init;
  get address(): net.AddressInfo;
  get remoteAddress(): readonly [string, number] | undefined;
  get closed(): boolean;
  get onData(): (data: Buffer, addr: Address) => void;
  set onData(handler: (data: Buffer, addr: Address) => void);
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
}
export declare class TlsTransport implements Transport {
  readonly type: "tls";
  private readonly stream;
  private constructor();
  static init(
    addr: Address,
    options?: TlsConnectionOptions,
    streamOptions?: StreamTransportOptions,
  ): Promise<TlsTransport>;
  private init;
  get address(): net.AddressInfo;
  get remoteAddress(): readonly [string, number] | undefined;
  get closed(): boolean;
  get onData(): (data: Buffer, addr: Address) => void;
  set onData(handler: (data: Buffer, addr: Address) => void);
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
}
export type IpAddressFamily = 4 | 6;
export interface Transport {
  type: string;
  address: AddressInfo;
  closed: boolean;
  onData: (data: Buffer, addr: Address) => void;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
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
