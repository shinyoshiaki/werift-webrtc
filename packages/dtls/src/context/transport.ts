import type { Address, Transport } from "../imports/common";

export class TransportContext {
  public socket: Transport;

  /**
   * Aborted by `close()` or `stopFlights()`: a flight waiting to retransmit
   * stops and no flight is sent any more.
   */
  private readonly closing = new AbortController();
  private isClosed = false;
  /** The one close of the socket, shared by every close() call. */
  private closePromise?: Promise<void>;

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

  /**
   * Close the socket once. Every call, including one made while the close is
   * still in progress, returns the same promise, which settles when the
   * socket's close() has finished. A close() that throws synchronously is
   * turned into a rejection of that promise (never a throw to the caller).
   */
  close(): Promise<void> {
    this.closing.abort();
    if (!this.closePromise) {
      this.isClosed = true;
      this.closePromise = (async () => {
        await this.socket.close();
      })();
    }
    return this.closePromise;
  }
}
