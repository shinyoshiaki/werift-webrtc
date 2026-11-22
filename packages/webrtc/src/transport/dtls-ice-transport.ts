import type { Connection } from "../../../ice/src";
import {
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import type { Address, DatagramRxMeta, Transport } from "../imports/common";
import type { IceConnection } from "../imports/ice";
import { isDtls } from "../utils";

/**
 * The DTLS socket's view of the ICE connection. The ICE connection belongs to
 * {@link RTCIceTransport} (shared with SRTP, stopped by
 * {@link RTCDtlsTransport.stop}): when the DTLS socket closes its transport
 * (after a received close_notify or fatal alert, or close()), this only
 * detaches DTLS from ICE; it never closes the ICE agent.
 */
class IceTransport implements Transport {
  closed: boolean = false;
  private readonly datagramSubscription: { unSubscribe(): void };
  /**
   * ICE selected-pair path is already authenticated — DTLS 1.2 must not treat
   * AEAD-protected alerts as "pre-auth" merely because UDP pin is unavailable.
   */
  readonly peerAuthenticated = true;
  private ice: IceConnection;
  constructor(ice: IceConnection) {
    this.ice = ice;
    this.datagramSubscription = connectionDatagramEvent(ice).subscribe(
      (ctx) => {
        // RFC 8445 §9: after an ICE restart the peer keeps sending on the
        // previously selected pair until a new pair is selected. This
        // transport carries the non-SPED association, which is the same
        // DTLS association on both paths, so accept DTLS from that retained
        // (previously authenticated) pair as well; dropping it stalls a
        // handshake that straddles the restart. The SPED carrier does not
        // use this transport and keeps the strict current-generation rule.
        if (
          isDtls(ctx.bytes) &&
          (ctx.fromPreviousSelectedPair === true ||
            allowsAuthenticatedDtlsDelivery(
              ctx,
              (ice as Connection).generation,
            ))
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

  /**
   * The DTLS association may record a datagram source here (as on a UDP
   * transport). ICE routes every send over the nominated pair, so the value
   * is not used: ignore it instead of throwing on the read-only accessor.
   */
  set rinfo(_rinfo: { address?: string; port?: number } | undefined) {}

  type: string = "ice";

  readonly send = (data: Buffer, _addr?: Address) => {
    if (this.closed) return Promise.resolve();
    return this.ice.send(data);
  };

  /** Detach DTLS from ICE: no more DTLS records in either direction. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.datagramSubscription.unSubscribe();
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
