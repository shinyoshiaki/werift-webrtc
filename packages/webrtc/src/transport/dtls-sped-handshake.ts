import { DirectHandshakeCarrier } from "../../../dtls/src/carrier/direct";
import { refragmentPendingFlightIfNeeded } from "../../../dtls/src/internal";
import type { Connection } from "../../../ice/src";
import { attachSpedToConnection } from "../../../ice/src/internal/sped";
import { DtlsClient, type DtlsSocket } from "../imports/dtls";
import type { DtlsState } from "./dtls-types";
import { IceSpedTransport } from "./sped";

/**
 * @internal What the SPED handshake needs from its {@link RTCDtlsTransport}.
 * Each method is one transport-level state transition; the handshake itself
 * only drives the SPED runtime, the handshake carrier and the SPED transport.
 */
export interface SpedHandshakeHost {
  readonly connection: Connection;
  /** WARP: the DTLS server may send application data before authentication. */
  allowsEarlyServerData(): boolean;
  /** WARP: application data may use a valid pair before ICE nomination. */
  sendsBeforeNomination(): boolean;
  /** Transport state when a SPED callback runs. */
  state(): DtlsState;
  /** The SPED transport carries this association's records from now on. */
  adoptSpedTransport(transport: IceSpedTransport): void;
  /**
   * Create the transport's DTLS socket on `transport` / `carrier` and settle
   * the start with its connect / close / error events.
   */
  createSocket(
    transport: IceSpedTransport,
    carrier: DirectHandshakeCarrier,
    resolve: () => void,
    reject: (error: Error) => void,
  ): DtlsSocket;
  /** The client's connect() failed: the start fails with `error`. */
  failStart(error: Error, reject: (error: Error) => void): void;
  /**
   * The SPED session restarted for `generation` (ICE restart, or a reset in
   * the same generation): the early attempt is cancelled and a connecting
   * handshake continues as a new attempt.
   */
  resetForGeneration(generation: number): void;
  /**
   * Early application data of the current attempt is abandoned (SPED abort,
   * direct DTLS fallback). `revoke` names the SRTP permissions withdrawn.
   */
  abandonEarlyApplication(revoke: "read-and-write" | "write"): void;
  /** The association completed over direct DTLS: no early server output. */
  endEarlyServerMode(): void;
  /** The lower socket is (again) write-ready for the current attempt. */
  markWriteReady(): void;
}

/**
 * @internal Run the DTLS handshake embedded in ICE (SPED) and resolve when
 * the DTLS socket connected. Falls back to direct DTLS when the peer does not
 * support SPED or the session aborts.
 */
export async function runSpedHandshake(host: SpedHandshakeHost): Promise<void> {
  const ice = host.connection;
  const transport = new IceSpedTransport(ice);
  host.adoptSpedTransport(transport);
  transport.setEarlyApplicationSendEnabled(host.allowsEarlyServerData());
  transport.setSendBeforeNomination(host.sendsBeforeNomination());
  const carrier = new DirectHandshakeCarrier(transport);
  carrier.setWireSendEnabled(false);
  carrier.setRetransmissionMode("external");

  let lastFlight: Buffer[] = [];
  let handshakeDone = false;
  let dtlsSocket: DtlsSocket | undefined;
  const handle = attachSpedToConnection(ice, {
    inject: async (bytes, peer, generation) => {
      if (ice.generation !== generation) {
        return;
      }
      await carrier.inject(bytes, peer ? [peer[0], peer[1]] : undefined, {
        rxGeneration: generation,
      });
    },
    onSessionReset: () => {
      carrier.invalidateInboundInjects?.();
      host.resetForGeneration(ice.generation);
      if (host.state() === "connected" || handshakeDone) {
        if (handle.runtime.isDirectCarrierSelected()) {
          if (dtlsSocket?.isDtls13) {
            handle.runtime.completeDirectFallback();
          } else {
            handle.runtime.commitDirectFallback();
          }
        } else if (dtlsSocket?.isDtls13) {
          handle.runtime.completeHandshake();
        } else {
          handle.runtime.commitDirectFallback();
        }
        return;
      }
      // New ICE generation starts SPED probing again.
      transport.disableHandshakeDirect();
      carrier.setWireSendEnabled(false);
      carrier.setRetransmissionMode("external");
      if (host.state() === "connecting" && lastFlight.length > 0) {
        handle.onFlightCreated(lastFlight);
        if (dtlsSocket?.readiness.writeReady) {
          host.markWriteReady();
        }
      }
    },
    onSessionAbort: () => {
      // ICE/SPED abort invalidates early SRTP permission immediately. The
      // DTLS association may still be connecting, so peer authentication is
      // not sufficient to reconstruct this permission until a new attempt.
      host.abandonEarlyApplication("read-and-write");
      transport.disableHandshakeDirect();
      carrier.invalidateInboundInjects?.();
      carrier.cancelAllTimers();
    },
    onFallbackFlight: async () => {
      host.abandonEarlyApplication("write");
      carrier.setWireSendEnabled(true);
    },
    onHandshakeComplete: () => {
      handshakeDone = true;
      carrier.setWireSendEnabled(true);
      transport.markApplicationReady();
    },
    onDirectHandshakeReady: (readiness) => {
      if (readiness.generation !== ice.generation) {
        return;
      }
      if (!readiness.ready || !readiness.pair) {
        transport.disableHandshakeDirect();
        if (host.state() === "connecting" && !handshakeDone) {
          carrier.setWireSendEnabled(false);
          carrier.setRetransmissionMode("external");
        }
        return;
      }
      transport.enableHandshakeDirect(readiness.pair, readiness.generation);
      carrier.setWireSendEnabled(true);
    },
    setRetransmissionMode: (mode) => carrier.setRetransmissionMode(mode),
    updateRtt: (rttMs) => carrier.updateRtt(rttMs),
    resetRtt: () => carrier.resetRtt(),
    setMtu: (mtu) => carrier.setMtu(mtu),
    refragmentPendingFlight: () => {
      if (dtlsSocket) {
        refragmentPendingFlightIfNeeded(dtlsSocket);
      }
    },
  });
  transport.setRuntime(handle.runtime);

  carrier.events.onFlightCreated = (_flightId, packets) => {
    if (handle.runtime.isStaleCarrierFlight()) {
      return;
    }
    lastFlight = packets.map((packet) => Buffer.from(packet.bytes));
    handle.onFlightCreated(lastFlight, { fromCarrier: true });
  };

  await new Promise<void>((resolve, reject) => {
    const socket = host.createSocket(transport, carrier, resolve, reject);
    dtlsSocket = socket;
    socket.onConnect.once(() => {
      const directFallback =
        handle.runtime.fallbackStarted ||
        handle.runtime.session.state === "fallback" ||
        handle.runtime.session.peerSupport === "unsupported";
      if (socket.isDtls13 && !directFallback) {
        handle.onHandshakeComplete();
        return;
      }
      handshakeDone = true;
      host.endEarlyServerMode();
      carrier.setWireSendEnabled(true);
      if (socket.isDtls13) {
        handle.runtime.completeDirectFallback();
      } else {
        handle.runtime.commitDirectFallback();
      }
      transport.markApplicationReady();
    });

    if (socket instanceof DtlsClient) {
      // SPED でも restart 後に同じ socket で connect() をやり直す経路は
      // ないため、attempt の付け替えに関係なく現在の失敗として扱う。
      socket.connect().catch((error) => host.failStart(error, reject));
    }
  });
}
