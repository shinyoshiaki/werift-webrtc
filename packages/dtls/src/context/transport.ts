import type { Address, Transport } from "../imports/common";

export class TransportContext {
  constructor(public socket: Transport) {}

  readonly send = (buf: Buffer, addr?: Address) => {
    return this.socket.send(buf, addr);
  };
}
