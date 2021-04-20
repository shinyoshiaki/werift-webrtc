import { Transport } from "../transport";

export class TransportContext {
  constructor(public socket: Transport) {}

  readonly send = this.socket.send;
}
