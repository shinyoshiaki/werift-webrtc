import { Transport } from "../transport";

export class TransportContext {
  constructor(public socket: Transport) {
    this.send = this.socket.send;
  }

  readonly send: (arg0: Buffer) => void;
}
