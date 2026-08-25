/**
 * Minimal handshake datagram carrier for direct UDP and future SPED (Epic 2).
 * Association depends only on this interface so custom carriers can be injected.
 */

export interface DtlsHandshakeDatagram {
  /** Defensive copy of serialized flight bytes (immutable after creation). */
  readonly bytes: Buffer;
  readonly flightId: number;
  readonly packetIndex: number;
  readonly retransmittable: boolean;
}

export type RetransmissionMode = "internal" | "external";

/** Peer address for inject / cookie binding (ip:port). */
export type InjectPeerAddr =
  | [string, number]
  | { address?: string; port?: number }
  | string;

/**
 * Transport-independent handshake carrier (Epic 1 direct UDP / Epic 2 SPED).
 * Association schedules retransmit via schedule(); external mode must stop timers.
 */
export interface DtlsHandshakeCarrier {
  /** Observability + mode-change hooks used by the association. */
  readonly events: CarrierEvents;

  /**
   * Send one handshake datagram. When `addr` is set, deliver to that peer
   * (never rely solely on last UDP rinfo).
   */
  send(packet: DtlsHandshakeDatagram, addr?: [string, number]): Promise<void>;

  /**
   * Inject a received datagram into the DTLS engine (SPED / dual-engine reinject).
   * Resolves when that datagram's RX processing has finished (not the whole chain).
   * Optional peer preserves source address for cookie address-validation binding.
   */
  inject(bytes: Buffer, peer?: InjectPeerAddr): Promise<void>;

  /** Wire inbound inject → association handleDatagram. */
  setInjectHandler(
    handler: (bytes: Buffer, peer?: InjectPeerAddr) => void | Promise<void>,
  ): void;

  /**
   * When false, {@link send} does not write handshake datagrams to the
   * transport (SPED embeds them in ICE Binding instead).
   */
  setWireSendEnabled?(enabled: boolean): void;

  getMtu(): number;
  setMtu(mtu: number): void;

  updateRtt(rttMs: number): void;
  getRtt(): number;

  setRetransmissionMode(mode: RetransmissionMode): void;
  getRetransmissionMode(): RetransmissionMode;

  /**
   * Schedule a cancelable timer (internal retransmission).
   * Must no-op while mode is external or after close().
   * @returns cancel function
   */
  schedule(ms: number, fn: () => void): () => void;

  /** Cancel all pending timers (close / error / handshake complete / external). */
  cancelAllTimers(): void;

  close(): void;
  isClosed(): boolean;
}

export interface CarrierEvents {
  onHandshakeDatagram?: (packet: DtlsHandshakeDatagram) => void;
  onFlightCreated?: (
    flightId: number,
    packets: DtlsHandshakeDatagram[],
  ) => void;
  onHandshakeComplete?: () => void;
  /** Fired when retransmission mode changes (e.g. external → internal resumes timers). */
  onRetransmissionModeChange?: (mode: RetransmissionMode) => void;
}
