import type { Transport } from "../imports/common";

export class TransportContext {
  constructor(public socket: Transport) {}

  readonly send = (buf: Buffer) => {
    return this.socket.send(buf);
  };
}
