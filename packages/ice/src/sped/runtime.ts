import type { CandidatePair } from "../iceBase";
import type { Address } from "../imports/common";
import type { Message } from "../stun/message";
import { getRawAttributeValue } from "../stun/rawAttributeValue";
import { StunOverTurnProtocol } from "../turn/protocol";
import type { Protocol } from "../types/model";

import { decodeSpedData, encodeSpedAck } from "./draft00";
import { DTLS_IN_STUN_DATA, SPED_OUTER_MTU } from "./draft00/constants";
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
  return (
    a === b ||
    (a.protocol === b.protocol &&
      a.remoteAddr[0] === b.remoteAddr[0] &&
      a.remoteAddr[1] === b.remoteAddr[1])
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
  if (!isSpedEligibleProtocol(pair.protocol)) {
    return false;
  }
  const transport = pair.localCandidate.transport.toLowerCase();
  const remoteType = pair.remoteCandidate.type;
  if (transport === "tcp") {
    return remoteType === "host" || remoteType === "prflx";
  }
  return remoteType === "host" || remoteType === "srflx";
}

/** UDP prflx is unconfirmed: it may later prove to be relay (trickle). */
function isUnconfirmedUdpPrflx(pair: CandidatePair): boolean {
  return (
    isSpedEligibleProtocol(pair.protocol) &&
    pair.localCandidate.transport.toLowerCase() === "udp" &&
    pair.remoteCandidate.type === "prflx"
  );
}

function unconfirmedPairKey(pair: CandidatePair): string {
  return `${pair.remoteAddr[0]}:${pair.remoteAddr[1]}:${pair.localCandidate.transport.toLowerCase()}`;
}

type SpedBindingRole = "full" | "capability" | "none";

/**
 * ICE-facing SPED controller. Package-private; not exported from `src/index.ts`.
 */
export class SpedRuntime {
  fallbackStarted = false;
  /**
   * Pair that received the first non-empty DTLS DATA (or carried direct
   * fallback). Empty capability ads must not pin.
   */
  lastPath?: CandidatePair;
  /**
   * UDP prflx 5-tuples that saw a current-generation authenticated Binding
   * without C070. Capability stays unknown until trickle proves host/srflx
   * (unsupported) / relay (ineligible) or end-of-candidates settles the
   * pair as a lasting peer-reflexive path.
   */
  private pendingUnconfirmedMissingData = new Set<string>();
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
    return this.bindingRole(pair, "out") === "full";
  }

  /**
   * full: L1 DATA + ACK on the association path.
   * capability: empty C070 only (other eligible pairs after pin, or
   *   UDP prflx after the peer already advertised DATA).
   * none: relay / TURN / unconfirmed UDP prflx without evidence.
   *
   * A UDP prflx that already received non-empty DATA is the association
   * path until signaling upgrades it (host/srflx) or marks it relay.
   */
  private bindingRole(
    pair: CandidatePair,
    direction: "in" | "out",
  ): SpedBindingRole {
    if (!this.session.embedding) {
      return "none";
    }
    const association = this.associationPath();
    if (association && sameCandidatePair(association, pair)) {
      return "full";
    }
    if (isSpedEligiblePair(pair)) {
      return association ? "capability" : "full";
    }
    if (isUnconfirmedUdpPrflx(pair)) {
      if (direction === "in") {
        return "capability";
      }
      return this.session.peerSupport === "supported" ? "capability" : "none";
    }
    return "none";
  }

  /**
   * Drop lastPath when trickle proves the pinned address is relay.
   */
  private associationPath(): CandidatePair | undefined {
    if (!this.lastPath) {
      return undefined;
    }
    if (
      isSpedEligiblePair(this.lastPath) ||
      isUnconfirmedUdpPrflx(this.lastPath)
    ) {
      return this.lastPath;
    }
    this.lastPath = undefined;
    return undefined;
  }

  decorateOutgoing(message: Message, pair: CandidatePair): boolean {
    const role = this.bindingRole(pair, "out");
    if (role === "none") {
      return true;
    }
    if (role === "capability") {
      return this.session.decorateCapabilityAdvertisement(message);
    }
    this.syncMtuFromBinding(message);
    return this.session.decorate(message);
  }

  isLiveGeneration(generation: number): boolean {
    return this.session.generation === generation;
  }

  /**
   * Remember the association pair for this generation.
   * Later candidates must not replace it.
   */
  pinHandshakePath(pair: CandidatePair): void {
    if (!this.lastPath) {
      this.lastPath = pair;
    }
  }

  /**
   * Resolve a previously pending C070-less UDP prflx Binding.
   * host/srflx trickle → unsupported; relay → drop pending; lasting prflx
   * after end-of-candidates or nomination → unsupported.
   * @returns true when this call locked peerSupport to unsupported.
   */
  settleUnconfirmedPair(
    pair: CandidatePair,
    options: {
      endOfCandidates: boolean;
      authenticated: boolean;
      nominated: boolean;
    },
  ): boolean {
    if (!this.session.embedding || this.session.peerSupport !== "unknown") {
      return false;
    }
    const key = unconfirmedPairKey(pair);
    if (!this.pendingUnconfirmedMissingData.has(key)) {
      return false;
    }
    if (pair.remoteCandidate.type === "relay") {
      this.pendingUnconfirmedMissingData.delete(key);
      return false;
    }
    if (isSpedEligiblePair(pair)) {
      this.pendingUnconfirmedMissingData.delete(key);
      this.session.noteAuthenticatedBindingHasData(false);
      return true;
    }
    if (
      options.authenticated &&
      isUnconfirmedUdpPrflx(pair) &&
      (options.endOfCandidates || options.nominated)
    ) {
      this.pendingUnconfirmedMissingData.delete(key);
      this.session.noteAuthenticatedBindingHasData(false);
      return true;
    }
    return false;
  }

  syncRtt(pair: CandidatePair): void {
    const association = this.associationPath();
    if (association) {
      if (!sameCandidatePair(association, pair)) {
        return;
      }
    } else if (!isSpedEligiblePair(pair)) {
      // Relay / TURN / unconfirmed UDP prflx must not seed the carrier
      // before the association is pinned.
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
    if (!pair) {
      return { fallback: false };
    }
    if (isUnconfirmedUdpPrflx(pair)) {
      const association = this.associationPath();
      if (association && !sameCandidatePair(association, pair)) {
        this.session.receiveCapabilityAdvertisement(message);
        return { fallback: false };
      }
      const dataValue = getRawAttributeValue(message, DTLS_IN_STUN_DATA);
      if (dataValue === undefined) {
        this.pendingUnconfirmedMissingData.add(unconfirmedPairKey(pair));
        return { fallback: false };
      }
      this.pendingUnconfirmedMissingData.delete(unconfirmedPairKey(pair));
      if (decodeSpedData(dataValue).kind !== "datagram") {
        this.session.receiveCapabilityAdvertisement(message);
        return { fallback: false };
      }
    } else {
      const role = this.bindingRole(pair, "in");
      if (role === "none") {
        return { fallback: false };
      }
      if (role === "capability") {
        this.session.receiveCapabilityAdvertisement(message);
        return { fallback: false };
      }
    }
    this.markInjectGeneration(generation);
    const result = this.session.receiveAuthenticated(message);
    if (result.inject) {
      this.pinHandshakePath(pair);
    }
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
    this.pendingUnconfirmedMissingData.clear();
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
      this.pendingUnconfirmedMissingData.clear();
      return;
    }
    this.session.abort();
    this.fallbackStarted = true;
    this.pendingInjectGeneration = undefined;
    this.lastPath = undefined;
    this.pendingUnconfirmedMissingData.clear();
    this.hooks.setRetransmissionMode("internal");
    this.hooks.onSessionAbort?.();
  }

  close(): void {
    this.abort();
  }
}
