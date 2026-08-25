import type { CandidatePair } from "../iceBase";
import type { Address } from "../imports/common";
import type { Message } from "../stun/message";
import { StunOverTurnProtocol } from "../turn/protocol";
import type { Protocol } from "../types/model";

import { encodeSpedAck } from "./draft00";
import { SPED_OUTER_MTU } from "./draft00/constants";
import {
  defaultSpedDtlsMtu,
  maxPayloadFitting,
  remainingDataValueBudget,
} from "./draft00/mtu";
import type { SpedSession } from "./draft00/session";

export type SpedRetransmissionMode = "internal" | "external";

export interface SpedHooks {
  inject: (bytes: Buffer, peer: Address, generation: number) => Promise<void>;
  onFallbackFlight: (packets: Buffer[]) => Promise<void>;
  onHandshakeComplete?: () => void;
  setRetransmissionMode: (mode: SpedRetransmissionMode) => void;
  updateRtt: (rttMs: number) => void;
  setMtu: (mtu: number) => void;
}

export function isSpedEligibleProtocol(protocol: Protocol): boolean {
  if (protocol.type === StunOverTurnProtocol.type || protocol.type === "turn") {
    return false;
  }
  const local = protocol.localCandidate;
  if (!local || local.type === "relay") {
    return false;
  }
  const transport = local.transport.toLowerCase();
  if (transport === "tcp") {
    return true;
  }
  return (
    transport === "udp" && (local.type === "host" || local.type === "srflx")
  );
}

/**
 * ICE-facing SPED controller. Package-private; not exported from `src/index.ts`.
 */
export class SpedRuntime {
  fallbackStarted = false;
  lastPath?: { protocol: Protocol; addr: Address; generation: number };
  private pendingInjectGeneration?: number;

  constructor(
    readonly session: SpedSession,
    readonly hooks: SpedHooks,
  ) {
    this.hooks.setRetransmissionMode("external");
    this.hooks.setMtu(defaultSpedDtlsMtu());
  }

  shouldDecorate(protocol: Protocol): boolean {
    return this.session.embedding && isSpedEligibleProtocol(protocol);
  }

  decorateOutgoing(message: Message, protocol: Protocol): boolean {
    if (!this.shouldDecorate(protocol)) {
      return true;
    }
    this.syncMtuFromBinding(message);
    return this.session.decorate(message);
  }

  isLiveGeneration(generation: number): boolean {
    return this.session.generation === generation;
  }

  syncRtt(pair: CandidatePair): void {
    if (pair.rtt == null || !(pair.rtt > 0)) {
      return;
    }
    this.hooks.updateRtt(pair.rtt * 1000);
  }

  syncMtu(messageSkeletonLength?: number): void {
    const overhead = messageSkeletonLength ?? 0;
    const mtu = Math.max(1, SPED_OUTER_MTU - overhead);
    this.hooks.setMtu(mtu);
  }

  /** DTLS datagram MTU from this Binding's current attributes (before SPED/MI/FP). */
  syncMtuFromBinding(message: Message): void {
    const ackValue = encodeSpedAck(this.session.peekAcksForBinding()).value;
    const mtu = Math.max(
      1,
      maxPayloadFitting(remainingDataValueBudget(message, ackValue)),
    );
    this.hooks.setMtu(mtu);
  }

  markInjectGeneration(generation: number): void {
    this.pendingInjectGeneration = generation;
  }

  isInjectGenerationCurrent(generation: number): boolean {
    return this.pendingInjectGeneration === generation;
  }

  async handleAuthenticatedStun(
    message: Message,
    addr: Address,
    generation: number,
    protocol?: Protocol,
  ): Promise<{ fallback: boolean; inject?: Buffer }> {
    if (!this.isLiveGeneration(generation)) {
      return { fallback: false };
    }
    this.markInjectGeneration(generation);
    if (protocol) {
      this.lastPath = { protocol, addr, generation };
    }
    const result = this.session.receiveAuthenticated(message);
    if (
      !this.isLiveGeneration(generation) ||
      !this.isInjectGenerationCurrent(generation)
    ) {
      return { fallback: false };
    }
    if (result.inject) {
      await this.hooks.inject(result.inject, addr, generation);
    }
    if (
      !this.isLiveGeneration(generation) ||
      !this.isInjectGenerationCurrent(generation)
    ) {
      return { fallback: false };
    }
    return result;
  }

  beginFallback(): Buffer[] {
    if (this.fallbackStarted) {
      return [];
    }
    this.fallbackStarted = true;
    this.hooks.setRetransmissionMode("internal");
    return this.session.fallbackFlightBytes();
  }

  completeHandshake(): void {
    this.session.completeHandshake();
    this.hooks.setRetransmissionMode("internal");
    this.hooks.onHandshakeComplete?.();
  }

  reset(generation: number): void {
    this.session.reset(generation);
    this.fallbackStarted = false;
    this.pendingInjectGeneration = undefined;
    this.lastPath = undefined;
    this.hooks.setRetransmissionMode("external");
    this.hooks.setMtu(defaultSpedDtlsMtu());
  }

  close(): void {
    this.session.clearL1();
    this.pendingInjectGeneration = undefined;
    this.hooks.setRetransmissionMode("internal");
  }
}
