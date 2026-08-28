import type { CandidatePair, Connection } from "../../../ice/src";
import {
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
  isAuthenticatedHandshakePair,
} from "../../../ice/src/internal/datagram";
import type { SpedRuntime } from "../../../ice/src/sped/runtime";
import type { Address, Transport } from "../imports/common";
import { isDtls } from "../utils";

/**
 * ICE Transport for SPED: handshake send is suppressed while embedding,
 * then uses the authenticated CandidatePair (pre-nomination handshake only).
 * After DTLS is up, application records always use Connection.send().
 */
export class IceSpedTransport implements Transport {
  closed = false;
  readonly peerAuthenticated = true;
  type = "ice-sped";
  private runtime?: SpedRuntime;
  /**
   * True after the first DTLS handshake completes. ICE restart after
   * DTLS is connected marks SPED complete so application records stay
   * on the nominated path.
   */
  private applicationReady = false;

  constructor(private readonly ice: Connection) {
    connectionDatagramEvent(ice).subscribe((ctx) => {
      if (!isDtls(ctx.bytes) || !this.onData) {
        return;
      }
      if (!allowsAuthenticatedDtlsDelivery(ctx, ice.generation)) {
        return;
      }
      if (this.applicationReady && !this.allowsApplicationDtls(ctx.pair)) {
        return;
      }
      this.onData(ctx.bytes, ctx.source);
    });
  }

  setRuntime(runtime: SpedRuntime) {
    this.runtime = runtime;
  }

  markApplicationReady() {
    this.applicationReady = true;
  }

  /**
   * After DTLS is up, application records follow the selected ICE path.
   * Restart with no nominated pair is blocked. TCP ICE sends on the local
   * active (nominated) socket and receives on the local passive socket.
   */
  private allowsApplicationDtls(pair?: CandidatePair): boolean {
    const nominated = this.ice.nominated;
    if (!nominated || !pair) {
      return false;
    }
    if (pair === nominated) {
      return true;
    }
    return (
      pair.component === nominated.component &&
      pair.localCandidate.transport.toLowerCase() === "tcp" &&
      nominated.localCandidate.transport.toLowerCase() === "tcp"
    );
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

  readonly send = async (data: Buffer, addr?: Address) => {
    if (this.applicationReady) {
      await this.ice.send(data);
      return;
    }
    if (this.runtime?.session.embedding) {
      return;
    }
    if (this.ice.nominated) {
      await this.ice.send(data);
      return;
    }
    const pair = this.resolveAuthenticatedSendPair(addr);
    if (!pair) {
      return;
    }
    this.runtime?.pinHandshakePath(pair);
    await pair.protocol.sendData(data, pair.remoteAddr);
  };

  async close() {
    this.closed = true;
  }

  /**
   * Match the carrier dest to an authenticated current-generation pair.
   * A pinned lastPath must not be abandoned for a later candidate.
   */
  private resolveAuthenticatedSendPair(
    addr?: Address,
  ): CandidatePair | undefined {
    const pinned = this.runtime?.lastPath;
    if (pinned && this.isCurrentAuthenticatedPair(pinned)) {
      if (!addr) {
        return pinned;
      }
      if (
        pinned.remoteAddr[0] === addr[0] &&
        pinned.remoteAddr[1] === addr[1]
      ) {
        return pinned;
      }
      return undefined;
    }
    if (!addr) {
      return undefined;
    }
    const list = this.ice.checkList ?? [];
    return list.find(
      (pair) =>
        pair.remoteAddr[0] === addr[0] &&
        pair.remoteAddr[1] === addr[1] &&
        this.isCurrentAuthenticatedPair(pair),
    );
  }

  private isCurrentAuthenticatedPair(pair: CandidatePair): boolean {
    const list = this.ice.checkList ?? [];
    if (!list.includes(pair) && this.ice.nominated !== pair) {
      return false;
    }
    return isAuthenticatedHandshakePair(pair);
  }

  private remotePeer(): Address {
    const nominated = this.ice.nominated;
    if (nominated) {
      return nominated.remoteAddr;
    }
    const path = this.runtime?.lastPath;
    if (path) {
      return path.remoteAddr;
    }
    return ["0.0.0.0", 0];
  }
}
