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
    // Defensive: never mutate caller's buffer after send
    const bytes = Buffer.from(packet.bytes);
    this.events.onHandshakeDatagram?.(packet);
    await this.transport.send(bytes);
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
    this.mode = mode;
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

/** Create an immutable handshake datagram (defensive copy of bytes). */
export function createHandshakeDatagram(
  bytes: Buffer,
  flightId: number,
  packetIndex: number,
  retransmittable = true,
): DtlsHandshakeDatagram {
  return Object.freeze({
    bytes: Buffer.from(bytes),
    flightId,
    packetIndex,
    retransmittable,
  });
}
