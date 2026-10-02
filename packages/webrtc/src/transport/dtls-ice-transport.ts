import type { Connection } from "../../../ice/src";
import {
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import type { Address, DatagramRxMeta, Transport } from "../imports/common";
import type { IceConnection } from "../imports/ice";
import { isDtls } from "../utils";

class IceTransport implements Transport {
  closed: boolean = false;
  private readonly datagramSubscription: { unSubscribe(): void };
  /**
   * ICE selected-pair path is already authenticated — DTLS 1.2 must not treat
   * AEAD-protected alerts as "pre-auth" merely because UDP pin is unavailable.
   */
  readonly peerAuthenticated = true;
  constructor(private ice: IceConnection) {
    this.datagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => {
        if (
          isDtls(ctx.bytes) &&
          allowsAuthenticatedDtlsDelivery(ctx, (ice as Connection).generation)
        ) {
          if (this.onData) {
            // 世代トークンを engine RX queue まで運び、restart 後の stale 実行を防ぐ。
            this.onData(ctx.bytes, ctx.source, {
              rxGeneration: ctx.generation,
            });
          }
        }
      },
    );
  }
  onData: (buf: Buffer, addr?: Address, meta?: DatagramRxMeta) => void =
    () => {};

  /**
   * DTLS 1.3 cookie HRR / anti-amp keys the peer from the RX 5-tuple.
   * ICE already demuxed to the nominated pair, so expose that remote address
   * instead of an empty AddressInfo (which made cookie HRR undeliverable).
   */
  get address() {
    const [address, port] = this.remotePeer();
    return { address, port, family: address.includes(":") ? "IPv6" : "IPv4" };
  }

  get rinfo() {
    const [address, port] = this.remotePeer();
    return { address, port };
  }

  type: string = "ice";

  readonly send = (data: Buffer, _addr?: Address) => {
    return this.ice.send(data);
  };

  async close() {
    this.closed = true;
    this.datagramSubscription.unSubscribe();
    this.ice.close();
  }

  private remotePeer(): Address {
    const nominated = this.ice.nominated;
    if (nominated) {
      return nominated.remoteAddr;
    }
    return ["0.0.0.0", 0];
  }
}

/** @internal DTLS socket carrier over the nominated ICE pair. */
export const createIceTransport = (ice: IceConnection) => new IceTransport(ice);
