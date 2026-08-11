import type { Address, Transport } from "../imports/common";

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
}
