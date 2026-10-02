import {
  type Address,
  type Transport,
  flushTransportSend,
} from "../imports/common";

export class TransportContext {
  /**
   * Association-owned peer destination for DTLS 1.2 TX.
   * When set, {@link send} without an explicit addr uses this tuple instead of
   * mutable UDP rinfo (which spoofed packets can overwrite before demux drop).
   * Dual association sets this via pin; clear on hard-close.
   */
  pinnedPeer?: Address;

  constructor(public socket: Transport) {}

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
}
