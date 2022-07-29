import { Transport } from "../transport";

export class TransportContext {
  constructor(_socket: Transport) {
    this.socket = _socket;
  }

  public socket: any = {};

  readonly send = this.socket.send;
}
