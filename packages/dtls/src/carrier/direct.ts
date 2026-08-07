import type { Transport } from "../imports/common";
import type {
  CarrierEvents,
  DtlsHandshakeCarrier,
  DtlsHandshakeDatagram,
  InjectPeerAddr,
  RetransmissionMode,
} from "./types";

const DEFAULT_MTU = 1200;

/**
 * Direct datagram carrier wrapping existing Transport (UDP etc.).
 * Epic 1 uses internal retransmission; external mode only stops timers (SPED skeleton).
 */
export class DirectHandshakeCarrier implements DtlsHandshakeCarrier {
  private mtu: number;
  private rttMs = 100;
  private mode: RetransmissionMode = "internal";
  private injectHandler?: (bytes: Buffer, peer?: InjectPeerAddr) => void;
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  readonly events: CarrierEvents = {};

  constructor(
    private readonly transport: Transport,
    options?: {
      mtu?: number;
      onInject?: (bytes: Buffer, peer?: InjectPeerAddr) => void;
    },
  ) {
    this.mtu = options?.mtu ?? DEFAULT_MTU;
    this.injectHandler = options?.onInject;
  }

  setInjectHandler(handler: (bytes: Buffer, peer?: InjectPeerAddr) => void) {
    this.injectHandler = handler;
  }

  async send(packet: DtlsHandshakeDatagram): Promise<void> {
    if (this.closed) return;
    // Defensive: never share retransmit-cache Buffer with callbacks or the wire path.
    // Mutating callback bytes must not corrupt pendingFlight retransmits.
    const wireBytes = Buffer.alloc(packet.bytes.length);
    packet.bytes.copy(wireBytes);
    if (this.events.onHandshakeDatagram) {
      const callbackCopy = Buffer.alloc(packet.bytes.length);
      packet.bytes.copy(callbackCopy);
      this.events.onHandshakeDatagram(
        Object.freeze({
          bytes: callbackCopy,
          flightId: packet.flightId,
          packetIndex: packet.packetIndex,
          retransmittable: packet.retransmittable,
        }),
      );
    }
    await this.transport.send(wireBytes);
  }

  inject(bytes: Buffer, peer?: InjectPeerAddr): void {
    if (this.closed) return;
    this.injectHandler?.(Buffer.from(bytes), peer);
  }

  getMtu(): number {
    return this.mtu;
  }

  setMtu(mtu: number) {
    this.mtu = mtu;
  }

  updateRtt(rttMs: number): void {
    if (rttMs > 0) this.rttMs = rttMs;
  }

  getRtt(): number {
    return this.rttMs;
  }

  setRetransmissionMode(mode: RetransmissionMode): void {
    const prev = this.mode;
    this.mode = mode;
    // external: stop local timers; connection may resume when returning to internal
    if (mode === "external") {
      this.cancelAllTimers();
    }
    if (prev !== mode) {
      this.events.onRetransmissionModeChange?.(mode);
    }
  }

  getRetransmissionMode(): RetransmissionMode {
    return this.mode;
  }

  /** Schedule a cancelable timer (internal retransmission). */
  schedule(ms: number, fn: () => void): () => void {
    if (this.closed || this.mode === "external") {
      return () => {};
    }
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed && this.mode === "internal") fn();
    }, ms);
    this.timers.add(id);
    return () => {
      clearTimeout(id);
      this.timers.delete(id);
    };
  }

  /** Cancel all pending timers (close / error / handshake complete). */
  cancelAllTimers(): void {
    for (const id of this.timers) {
      clearTimeout(id);
    }
    this.timers.clear();
  }

  close(): void {
    this.closed = true;
    this.cancelAllTimers();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Create an immutable handshake datagram with an owned copy of bytes.
 * Callers must not share the same Buffer instance between cache and callbacks;
 * use a separate createHandshakeDatagram() call for each consumer.
 * Note: Object.freeze does not freeze Buffer contents — only the wrapper.
 */
export function createHandshakeDatagram(
  bytes: Buffer,
  flightId: number,
  packetIndex: number,
  retransmittable = true,
): DtlsHandshakeDatagram {
  // Own copy so mutations of the source buffer cannot affect the datagram
  const owned = Buffer.alloc(bytes.length);
  bytes.copy(owned);
  return Object.freeze({
    bytes: owned,
    flightId,
    packetIndex,
    retransmittable,
  });
}
