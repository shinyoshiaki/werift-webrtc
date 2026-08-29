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

export function sameCandidatePair(a: CandidatePair, b: CandidatePair): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.protocol === b.protocol &&
    a.remoteAddr[0] === b.remoteAddr[0] &&
    a.remoteAddr[1] === b.remoteAddr[1]
  ) {
    return true;
  }
  // ICE-TCP active/passive are distinct CandidatePairs (and TCP connections)
  // toward the same host. Pinning one must not drop the other or both sides
  // can lock onto opposite connections and never exchange SPED DATA.
  return isSameIceTcpSpedPath(a, b);
}

function isSameIceTcpSpedPath(a: CandidatePair, b: CandidatePair): boolean {
  if (a.component !== b.component) {
    return false;
  }
  const aLocal = a.localCandidate;
  const bLocal = b.localCandidate;
  if (
    aLocal.transport.toLowerCase() !== "tcp" ||
    bLocal.transport.toLowerCase() !== "tcp" ||
    a.remoteCandidate.transport.toLowerCase() !== "tcp" ||
    b.remoteCandidate.transport.toLowerCase() !== "tcp"
  ) {
    return false;
  }
  return (
    aLocal.host === bLocal.host &&
    a.remoteCandidate.host === b.remoteCandidate.host
  );
}

export function isSpedEligibleProtocol(protocol: Protocol): boolean {
  if (protocol.type === StunOverTurnProtocol.type || protocol.type === "turn") {
    return false;
  }
  if (protocol instanceof StunOverTurnProtocol) {
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

export function isSpedEligiblePair(pair: CandidatePair): boolean {
  if (pair.localCandidate.type === "relay") {
    return false;
  }
  if (pair.remoteCandidate.type === "relay") {
    return false;
  }
  return isSpedEligibleProtocol(pair.protocol);
}

/**
 * ICE-facing SPED controller. Package-private; not exported from `src/index.ts`.
 */
export class SpedRuntime {
  fallbackStarted = false;
  /**
   * Authenticated current-generation pair used for pre-nomination handshake
   * send. Pinned on first use so a later Binding cannot move DTLS to another
   * candidate (multi-candidate contamination).
   */
  lastPath?: CandidatePair;
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

  shouldDecorate(pair: CandidatePair): boolean {
    if (!this.session.embedding || !isSpedEligiblePair(pair)) {
      return false;
    }
    if (this.lastPath && !sameCandidatePair(this.lastPath, pair)) {
      return false;
    }
    return true;
  }

  decorateOutgoing(message: Message, pair: CandidatePair): boolean {
    if (!this.shouldDecorate(pair)) {
      return true;
    }
    this.syncMtuFromBinding(message);
    return this.session.decorate(message);
  }

  isLiveGeneration(generation: number): boolean {
    return this.session.generation === generation;
  }

  /**
   * Remember the first authenticated handshake pair for this generation.
   * Later candidates must not replace it.
   */
  pinHandshakePath(pair: CandidatePair): void {
    if (!this.lastPath) {
      this.lastPath = pair;
    }
  }

  syncRtt(pair: CandidatePair): void {
    if (this.lastPath && !sameCandidatePair(this.lastPath, pair)) {
      return;
    }
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
    pair?: CandidatePair,
  ): Promise<{ fallback: boolean; inject?: Buffer }> {
    if (!this.session.embedding || !this.isLiveGeneration(generation)) {
      return { fallback: false };
    }
    if (!pair || !this.shouldDecorate(pair)) {
      return { fallback: false };
    }
    this.pinHandshakePath(pair);
    this.markInjectGeneration(generation);
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
