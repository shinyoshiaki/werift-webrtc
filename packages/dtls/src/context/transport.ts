import type { Address, Transport } from "../imports/common";

export class TransportContext {
  /** Aborted by `close()`: a flight waiting to retransmit stops. */
  private readonly closing = new AbortController();

  constructor(public socket: Transport) {}

  readonly send = (buf: Buffer, addr?: Address) => {
    return this.socket.send(buf, addr);
  };

  get closedSignal() {
    return this.closing.signal;
  }

  close() {
    this.closing.abort();
    return this.socket.close();
  }
}
