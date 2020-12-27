import { Transport } from "../transport";

export class TransportContext {
  constructor(public socket: Transport) {}

  send(buf: Buffer) {
    this.socket.send(buf);
  }
}
