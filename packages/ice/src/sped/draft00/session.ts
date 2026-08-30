import type { Message } from "../../stun/message";
import { getRawAttributeValue } from "../../stun/rawAttributeValue";

import {
  decodeSpedAck,
  decodeSpedData,
  encodeSpedAck,
  encodeSpedData,
  spedDataCrc32,
} from "./codec";
import { DTLS_IN_STUN_ACK, DTLS_IN_STUN_DATA } from "./constants";
import {
  estimatedStunSizeAfterSped,
  maxPayloadFitting,
  remainingDataValueBudget,
  stunFitsPathMtu,
} from "./mtu";
import type { SpedPeerSupport, SpedState } from "./types";

/**
 * Per-ICE-generation SPED draft-00 session (L1 / L2).
 * DTLS record ACK state stays in the DTLS engine — this only tracks STUN CRCs.
 */
export class SpedSession {
  state: SpedState;
  peerSupport: SpedPeerSupport = "unknown";
  generation: number;
  /** Un-ACKed current DTLS flight datagrams (defensive copies). */
  private l1: Buffer[] = [];
  /**
   * First L1 flight bytes. Fallback sends this snapshot even if later
   * MTU shrink re-fragments `l1` for STUN embedding.
   */
  private originalFallbackFlight?: Buffer[];
  /** Pending CRC-32 values to advertise, receive order. May exceed 4. */
  private l2: number[] = [];
  private roundRobinIndex = 0;
  private firstAuthenticatedSeen = false;

  constructor(generation: number, state: SpedState = "probing") {
    this.generation = generation;
    this.state = state;
  }

  get l1Datagrams(): Buffer[] {
    return this.l1.map((packet) => Buffer.from(packet));
  }

  get hasL1(): boolean {
    return this.l1.length > 0;
  }

  get l2Crcs(): number[] {
    return [...this.l2];
  }

  get embedding(): boolean {
    return this.state === "probing" || this.state === "active";
  }

  /**
   * Terminal stop: ICE failed / DTLS error / connection close.
   * ICE restart {@link reset} is required before probing again.
   */
  abort(): void {
    this.l1 = [];
    this.originalFallbackFlight = undefined;
    this.l2 = [];
    this.roundRobinIndex = 0;
    this.peerSupport = "unknown";
    this.state = "disabled";
    this.firstAuthenticatedSeen = false;
  }

  replaceL1(packets: readonly Buffer[]): void {
    if (this.state === "disabled") {
      return;
    }
    this.l1 = packets.map((packet) => {
      const copy = Buffer.alloc(packet.length);
      packet.copy(copy);
      return copy;
    });
    if (this.originalFallbackFlight == null && this.l1.length > 0) {
      this.originalFallbackFlight = this.l1.map((packet) =>
        Buffer.from(packet),
      );
    }
    this.roundRobinIndex = 0;
  }

  clearL1(): void {
    this.l1 = [];
    this.roundRobinIndex = 0;
  }

  queueAck(crc: number): void {
    if (this.state === "disabled") {
      return;
    }
    const value = crc >>> 0;
    if (this.l2.includes(value)) {
      return;
    }
    this.l2.push(value);
  }

  /** CRCs to put on this Binding (head of L2, hard cap 4). */
  peekAcksForBinding(): number[] {
    return this.l2.slice(0, 4);
  }

  /** Drop ACKs that were placed on a Binding; remainder stays for the next one. */
  consumeAcks(count: number): void {
    if (count <= 0) {
      return;
    }
    this.l2.splice(0, count);
  }

  applyAckCrcs(crcs: readonly number[]): void {
    if (crcs.length === 0) {
      return;
    }
    const set = new Set(crcs.map((crc) => crc >>> 0));
    this.l1 = this.l1.filter((packet) => !set.has(spedDataCrc32(packet)));
    if (this.roundRobinIndex >= this.l1.length) {
      this.roundRobinIndex = 0;
    }
  }

  /**
   * First current-generation authenticated Binding: DATA present (including
   * empty) → supported; missing DATA → unsupported / fallback.
   */
  noteAuthenticatedBindingHasData(hasData: boolean): SpedState {
    if (this.firstAuthenticatedSeen) {
      return this.state;
    }
    this.firstAuthenticatedSeen = true;
    if (hasData) {
      this.peerSupport = "supported";
      if (this.state === "probing") {
        this.state = "active";
      }
    } else {
      this.peerSupport = "unsupported";
      this.state = "fallback";
    }
    return this.state;
  }

  completeHandshake(): void {
    if (this.state === "disabled") {
      return;
    }
    this.l1 = [];
    this.originalFallbackFlight = undefined;
    this.l2 = [];
    this.roundRobinIndex = 0;
    this.state = "complete";
  }

  reset(generation: number): void {
    this.generation = generation;
    this.l1 = [];
    this.originalFallbackFlight = undefined;
    this.l2 = [];
    this.roundRobinIndex = 0;
    this.peerSupport = "unknown";
    this.state = "probing";
    this.firstAuthenticatedSeen = false;
  }

  /** Original L1 bytes for exact-same-flight fallback. */
  fallbackFlightBytes(): Buffer[] {
    const source = this.originalFallbackFlight ?? this.l1;
    return source.map((packet) => Buffer.from(packet));
  }

  selectDataPayload(maxValueBytes: number): Buffer {
    if (this.l1.length === 0 || maxValueBytes <= 0) {
      return Buffer.alloc(0);
    }
    const start = this.roundRobinIndex % this.l1.length;
    for (let offset = 0; offset < this.l1.length; offset++) {
      const index = (start + offset) % this.l1.length;
      const packet = this.l1[index]!;
      if (packet.length <= maxValueBytes) {
        this.roundRobinIndex = (index + 1) % this.l1.length;
        return Buffer.from(packet);
      }
    }
    return Buffer.alloc(0);
  }

  /**
   * ACK then DATA (draft §4.2), both before MESSAGE-INTEGRITY.
   * Returns false when even empty DATA would exceed the path MTU.
   */
  decorate(message: Message): boolean {
    if (!this.embedding) {
      return true;
    }
    const acks = this.peekAcksForBinding();
    const ackValue = encodeSpedAck(acks).value;
    const budget = remainingDataValueBudget(message, ackValue);
    const maxPayload = maxPayloadFitting(budget);
    const dataValue = this.selectDataPayload(maxPayload);
    const size = estimatedStunSizeAfterSped(message, ackValue, dataValue);
    if (!stunFitsPathMtu(size)) {
      return false;
    }
    message.appendRawAttribute(DTLS_IN_STUN_ACK, ackValue);
    message.appendRawAttribute(
      DTLS_IN_STUN_DATA,
      encodeSpedData(dataValue).value,
    );
    this.consumeAcks(acks.length);
    return true;
  }

  /**
   * Empty C070 only: advertise SPED support without moving L1 / L2 / ACK
   * onto a non-association pair.
   */
  decorateCapabilityAdvertisement(message: Message): boolean {
    if (!this.embedding) {
      return true;
    }
    const empty = Buffer.alloc(0);
    const size = estimatedStunSizeAfterSped(message, empty, empty);
    if (!stunFitsPathMtu(size)) {
      return false;
    }
    message.appendRawAttribute(DTLS_IN_STUN_DATA, encodeSpedData(empty).value);
    return true;
  }

  /**
   * DATA present → supported. Missing DATA does not lock unsupported
   * (unconfirmed prflx / non-association pair).
   */
  receiveCapabilityAdvertisement(message: Message): void {
    if (this.state === "disabled") {
      return;
    }
    const dataValue = getRawAttributeValue(message, DTLS_IN_STUN_DATA);
    if (dataValue !== undefined) {
      this.noteAuthenticatedBindingHasData(true);
    }
  }

  receiveAuthenticated(message: Message): {
    inject?: Buffer;
    fallback: boolean;
  } {
    if (this.state === "disabled") {
      return { fallback: false };
    }
    const dataValue = getRawAttributeValue(message, DTLS_IN_STUN_DATA);
    const ackValue = getRawAttributeValue(message, DTLS_IN_STUN_ACK);
    const state = this.noteAuthenticatedBindingHasData(dataValue !== undefined);
    if (ackValue) {
      const decoded = decodeSpedAck(ackValue);
      if (decoded.kind === "crcs") {
        this.applyAckCrcs(decoded.crcs);
      }
    }
    if (dataValue === undefined) {
      return { fallback: state === "fallback" };
    }
    const decoded = decodeSpedData(dataValue);
    if (decoded.kind === "empty") {
      return { fallback: false };
    }
    if (decoded.kind === "invalid-demux") {
      return { fallback: false };
    }
    this.queueAck(spedDataCrc32(decoded.bytes));
    return { inject: decoded.bytes, fallback: false };
  }
}
