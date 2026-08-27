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
  spedDtlsMtuForIceCredentials,
} from "./draft00/mtu";
import type { SpedSession } from "./draft00/session";

export type SpedRetransmissionMode = "internal" | "external";

export interface SpedHooks {
  inject: (bytes: Buffer, peer: Address, generation: number) => Promise<void>;
  onFallbackFlight: (packets: Buffer[]) => Promise<void>;
  onHandshakeComplete?: () => void;
  /** ICE restart / new generation: drop in-flight handshake injects. */
  onSessionReset?: () => void;
  /**
   * ICE failed / DTLS error / close: cancel carrier timers. Must not reseed L1.
   */
  onSessionAbort?: () => void;
  setRetransmissionMode: (mode: SpedRetransmissionMode) => void;
  updateRtt: (rttMs: number) => void;
  /** ICE restart: drop the previous generation's path RTT. */
  resetRtt: () => void;
  setMtu: (mtu: number) => void;
  /**
   * Path MTU shrank under an already-built flight (SPED is external RTO).
   * Rebuild pending datagrams and replace L1.
   */
  refragmentPendingFlight?: () => void;
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
  /** Last DTLS datagram MTU pushed to the carrier. */
  private lastMtu: number;

  constructor(
    readonly session: SpedSession,
    readonly hooks: SpedHooks,
  ) {
    this.hooks.setRetransmissionMode("external");
    this.lastMtu = defaultSpedDtlsMtu();
    this.hooks.setMtu(this.lastMtu);
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
    this.applyMtu(mtu, { allowRaise: true });
  }

  /**
   * Set DTLS MTU from actual ICE ufrags before the first flight
   * (min of Request and Response Binding budgets).
   */
  syncPathMtuFromConnection(connection: {
    localUsername: string;
    remoteUsername: string;
    options: { useIpv6: boolean };
  }): void {
    this.applyMtu(
      spedDtlsMtuForIceCredentials({
        localUsername: connection.localUsername,
        remoteUsername: connection.remoteUsername,
        useIpv6: connection.options.useIpv6,
      }),
      { allowRaise: true },
    );
  }

  /** DTLS datagram MTU from this Binding's current attributes (before SPED/MI/FP). */
  syncMtuFromBinding(message: Message): void {
    const ackValue = encodeSpedAck(this.session.peekAcksForBinding()).value;
    const mtu = Math.max(
      1,
      maxPayloadFitting(remainingDataValueBudget(message, ackValue)),
    );
    // A spacious Response must not raise MTU above the Request-side path limit.
    this.applyMtu(mtu, { allowRaise: false });
  }

  private applyMtu(mtu: number, options: { allowRaise: boolean }): void {
    if (!options.allowRaise && mtu >= this.lastMtu) {
      return;
    }
    if (mtu === this.lastMtu) {
      return;
    }
    const shrink = mtu < this.lastMtu;
    this.lastMtu = mtu;
    this.hooks.setMtu(mtu);
    if (shrink) {
      this.hooks.refragmentPendingFlight?.();
    }
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
    if (!this.session.embedding || !this.isLiveGeneration(generation)) {
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
    if (this.fallbackStarted || this.session.state === "disabled") {
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
    this.lastMtu = defaultSpedDtlsMtu();
    this.hooks.setMtu(this.lastMtu);
    this.hooks.resetRtt();
    this.hooks.onSessionReset?.();
  }

  /**
   * Stop embedding and drop pending L1/L2 / injects / last path.
   * ICE restart still uses {@link reset} to return to probing.
   */
  abort(): void {
    if (this.session.state === "disabled") {
      this.pendingInjectGeneration = undefined;
      this.lastPath = undefined;
      return;
    }
    this.session.abort();
    this.fallbackStarted = true;
    this.pendingInjectGeneration = undefined;
    this.lastPath = undefined;
    this.hooks.setRetransmissionMode("internal");
    this.hooks.onSessionAbort?.();
  }

  close(): void {
    this.abort();
  }
}
