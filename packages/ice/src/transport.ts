import debug from "debug";
import { createSocket, SocketType } from "dgram";

import { Address } from "./types/model";
import { findPort } from "./utils";

const log = debug("werift/ice/transport");

export class UdpTransport implements Transport {
  private socket = createSocket(this.type);
  onData: (data: Buffer, addr: Address) => void = () => {};

  constructor(private type: SocketType, private portRange?: [number, number]) {
    this.socket.on("message", (data, info) => {
      if (info.family === "IPv6") {
        [info.address] = info.address.split("%"); // example fe80::1d3a:8751:4ffd:eb80%wlp82s0
      }
      this.onData(data, [info.address, info.port]);
    });
  }

  static async init(type: SocketType, portRange?: [number, number]) {
    const transport = new UdpTransport(type, portRange);
    await transport.init();
    return transport;
  }

  private async init() {
    if (this.portRange) {
      const port = await findPort(
        this.portRange[0],
        this.portRange[1],
        this.type
      );
      this.socket.bind(port);
    } else {
      this.socket.bind();
    }
    await new Promise((r) => this.socket.once("listening", r));
  }

  send = (data: Buffer, addr: Address) =>
    new Promise<void>((r) => {
      try {
        this.socket.send(data, addr[1], addr[0], (error) => {
          if (error) {
            log("send error", addr, data);
          }
          r();
        });
      } catch (error) {
        log("send error", addr, data);
        r();
      }
    });

  address() {
    return this.socket.address();
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

export interface Transport {
  onData: (data: Buffer, addr: Address) => void;
  send: (data: Buffer, addr: Address) => Promise<void>;
}
