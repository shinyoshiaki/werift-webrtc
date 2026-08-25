import type { Connection } from "../../../ice/src";
import type { SpedRuntime } from "../../../ice/src/sped/runtime";
import type { Address, Transport } from "../imports/common";
import { isDtls } from "../utils";

/**
 * ICE Transport for SPED: handshake send is suppressed while embedding,
 * then uses the authenticated 5-tuple (pre-nomination) or nominated send.
 */
export class IceSpedTransport implements Transport {
  closed = false;
  readonly peerAuthenticated = true;
  type = "ice-sped";
  private runtime?: SpedRuntime;
  /**
   * True after the first DTLS handshake completes. ICE restart may put SPED
   * back into probing, but application records must still use the nominated path.
   */
  private applicationReady = false;

  constructor(private readonly ice: Connection) {
    ice.onData.subscribe((buf) => {
      if (isDtls(buf) && this.onData) {
        this.onData(buf, this.remotePeer());
      }
    });
  }

  setRuntime(runtime: SpedRuntime) {
    this.runtime = runtime;
  }

  markApplicationReady() {
    this.applicationReady = true;
  }

  onData: (buf: Buffer, addr?: Address) => void = () => {};

  /**
   * Writable so DtlsClient.associationInject can pin the authenticated STUN
   * source. Falls back to nominated / last SPED path when unset.
   */
  private rinfoPin?: { address: string; port: number };

  get address() {
    const [address, port] = this.remotePeer();
    return { address, port, family: address.includes(":") ? "IPv6" : "IPv4" };
  }

  get rinfo() {
    if (this.rinfoPin) {
      return this.rinfoPin;
    }
    const [address, port] = this.remotePeer();
    return { address, port };
  }

  set rinfo(value: { address?: string; port?: number } | undefined) {
    if (value?.address != null && value.port != null) {
      this.rinfoPin = { address: value.address, port: value.port };
    }
  }

  readonly send = async (data: Buffer, _addr?: Address) => {
    if (this.runtime?.session.embedding && !this.applicationReady) {
      return;
    }
    if (this.ice.nominated) {
      await this.ice.send(data);
      return;
    }
    const path = this.runtime?.lastPath;
    if (path) {
      await this.ice.sendHandshakeDatagram(
        path.protocol,
        path.addr,
        data,
        path.generation,
      );
    }
  };

  async close() {
    this.closed = true;
  }

  private remotePeer(): Address {
    const nominated = this.ice.nominated;
    if (nominated) {
      return nominated.remoteAddr;
    }
    const path = this.runtime?.lastPath;
    if (path) {
      return path.addr;
    }
    return ["0.0.0.0", 0];
  }
}
