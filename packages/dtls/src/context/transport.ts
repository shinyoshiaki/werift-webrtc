import { Transport } from "../transport";

export class TransportContext {
  constructor(public socket: Transport) {}

  readonly send = (buf: Buffer) => {
    return this.socket.send(buf);
  };
}
