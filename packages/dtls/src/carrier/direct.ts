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
  /**
   * RTT sample in ms. `undefined` until {@link updateRtt} — RFC 9147 §5.8.2
   * then uses the profile initial RTO (1000ms generic / 400ms DTLS-SRTP).
   * Never invent a default sample (previous 100ms falsely looked "known").
   */
  private rttMs: number | undefined = undefined;
  private mode: RetransmissionMode = "internal";
  private injectHandler?: (
    bytes: Buffer,
    peer?: InjectPeerAddr,
  ) => void | Promise<void>;
  private closed = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  readonly events: CarrierEvents = {};
  /** When false, send() does not write the datagram (SPED embeds it in STUN). */
  private wireSendEnabled = true;

  constructor(
    private readonly transport: Transport,
    options?: {
      mtu?: number;
      onInject?: (bytes: Buffer, peer?: InjectPeerAddr) => void;
      /** Optional initial RTT sample (e.g. ICE pair RTT). Omit = unknown. */
      rttMs?: number;
    },
  ) {
    this.mtu = options?.mtu ?? DEFAULT_MTU;
    this.injectHandler = options?.onInject;
    if (options?.rttMs != null && options.rttMs > 0) {
      this.rttMs = options.rttMs;
    }
  }

  setInjectHandler(
    handler: (bytes: Buffer, peer?: InjectPeerAddr) => void | Promise<void>,
  ) {
    this.injectHandler = handler;
  }

  setWireSendEnabled(enabled: boolean) {
    this.wireSendEnabled = enabled;
  }

  async send(
    packet: DtlsHandshakeDatagram,
    addr?: [string, number],
  ): Promise<void> {
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
    // Always pass explicit peer when known so UdpTransport.rinfo hijack cannot redirect
    if (!this.wireSendEnabled) {
      return;
    }
    await this.transport.send(wireBytes, addr);
  }

  async inject(bytes: Buffer, peer?: InjectPeerAddr): Promise<void> {
    if (this.closed) return;
    await this.injectHandler?.(Buffer.from(bytes), peer);
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

  /**
   * Last RTT sample in ms, or `0` when no sample has been provided yet
   * (association treats 0 as "RTT unknown" and uses initial RTO).
   */
  getRtt(): number {
    return this.rttMs ?? 0;
  }

  /** True after a positive updateRtt / constructor sample. */
  hasRttSample(): boolean {
    return this.rttMs != null && this.rttMs > 0;
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
