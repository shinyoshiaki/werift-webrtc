import type { Address, Transport } from "../imports/common";

export class TransportContext {
  public socket: Transport;

  /**
   * Aborted by `close()` or `stopFlights()`: a flight waiting to retransmit
   * stops and no flight is sent any more.
   */
  private readonly closing = new AbortController();
  private isClosed = false;

  constructor(socket: Transport) {
    this.socket = socket;
  }

  readonly send = (buf: Buffer, addr?: Address) => {
    return this.socket.send(buf, addr);
  };

  get closedSignal(): AbortSignal {
    return this.closing.signal;
  }

  /** Whether `close()` was called: nothing can be sent any more. */
  get closed() {
    return this.isClosed;
  }

  /** Stop sending and retransmitting handshake flights; the socket stays open. */
  stopFlights() {
    this.closing.abort();
  }

  /** Close the socket once; later calls resolve without closing it again. */
  close() {
    this.closing.abort();
    if (this.isClosed) return Promise.resolve();
    this.isClosed = true;
    return this.socket.close();
  }
}
