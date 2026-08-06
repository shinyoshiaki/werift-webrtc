/**
 * Minimal handshake datagram carrier for direct UDP and future SPED (Epic 2).
 * Shapes may evolve; capabilities are required.
 */

export interface DtlsHandshakeDatagram {
  /** Defensive copy of serialized flight bytes (immutable after creation). */
  readonly bytes: Buffer;
  readonly flightId: number;
  readonly packetIndex: number;
  readonly retransmittable: boolean;
}

export type RetransmissionMode = "internal" | "external";

export interface DtlsHandshakeCarrier {
  send(packet: DtlsHandshakeDatagram): Promise<void>;
  /** Inject a received datagram into the DTLS engine (used by SPED). */
  inject(bytes: Buffer): void;
  getMtu(): number;
  updateRtt(rttMs: number): void;
  setRetransmissionMode(mode: RetransmissionMode): void;
}

export interface CarrierEvents {
  onHandshakeDatagram?: (packet: DtlsHandshakeDatagram) => void;
  onFlightCreated?: (flightId: number, packets: DtlsHandshakeDatagram[]) => void;
  onHandshakeComplete?: () => void;
}
