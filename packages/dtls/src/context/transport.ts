import type { Address, Transport } from "../imports/common";

export class TransportContext {
  public socket: Transport;

  /** Aborted by `close()`: a flight waiting to retransmit stops. */
  private readonly closing = new AbortController();

  constructor(socket: Transport) {
    this.socket = socket;
  }

  readonly send = (buf: Buffer, addr?: Address) => {
    return this.socket.send(buf, addr);
  };

  get closedSignal(): AbortSignal {
    return this.closing.signal;
  }

  close() {
    this.closing.abort();
    return this.socket.close();
  }
}
