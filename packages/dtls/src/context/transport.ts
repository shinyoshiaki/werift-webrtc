import {
  type Address,
  flushTransportSend,
  type Transport,
} from "../imports/common";

export class TransportContext {
  public socket: Transport;

  /**
   * Association-owned peer destination for DTLS 1.2 TX.
   * When set, {@link send} without an explicit addr uses this tuple instead of
   * mutable UDP rinfo (which spoofed packets can overwrite before demux drop).
   * Dual association sets this via pin; clear on hard-close.
   */
  pinnedPeer?: Address;
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
    return this.socket.send(buf, addr ?? this.pinnedPeer);
  };

  /**
   * Application-data send path.  SPED transports use this marker because a
   * DTLS 1.3 application record has an encrypted inner content type and
   * cannot be classified from its wire header alone.
   */
  readonly sendApplication = (buf: Buffer, addr?: Address) => {
    const applicationTransport = this.socket as Transport & {
      sendApplication?: (data: Buffer, address?: Address) => Promise<void>;
    };
    return applicationTransport.sendApplication
      ? applicationTransport.sendApplication(buf, addr ?? this.pinnedPeer)
      : this.send(buf, addr);
  };

  /** Flush path for close_notify (does not change hot-path {@link send}). */
  readonly sendAndWait = (buf: Buffer, addr?: Address) => {
    return flushTransportSend(this.socket, buf, addr ?? this.pinnedPeer);
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
