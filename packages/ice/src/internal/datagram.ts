import { type CandidatePair, CandidatePairState } from "../iceBase";
import { type Address, Event } from "../imports/common";
import type { Protocol } from "../types/model";

const datagramEvents = new WeakMap<object, Event<[IceDatagramContext]>>();

/**
 * Internal source/generation-aware datagram event.
 * Not a Connection public member — PeerConfig.sped is the public enablement.
 */
export function connectionDatagramEvent(
  connection: object,
): Event<[IceDatagramContext]> {
  let event = datagramEvents.get(connection);
  if (!event) {
    event = new Event();
    datagramEvents.set(connection, event);
  }
  return event;
}

/**
 * Internal datagram routing context (not a Public ICE API).
 * Public {@link Connection.onData} remains `Event<[Buffer]>`.
 */
export interface IceDatagramContext {
  bytes: Buffer;
  source: Address;
  protocol: Protocol;
  pair?: CandidatePair;
  generation: number;
  authenticated: boolean;
}

/**
 * Same 5-tuple auth used for handshake send and inbound direct DTLS.
 * Binding Request receipt (`requestsReceived`) counts: the pair may still be
 * WAITING with no Binding Response yet.
 */
export function isAuthenticatedHandshakePair(pair: CandidatePair): boolean {
  return (
    pair.nominated ||
    pair.state === CandidatePairState.SUCCEEDED ||
    pair.responsesReceived > 0 ||
    pair.requestsReceived > 0
  );
}

/**
 * Direct DTLS may be delivered only on an authenticated current-generation
 * pair whose protocol and remote 5-tuple match the datagram source.
 */
export function allowsAuthenticatedDtlsDelivery(
  ctx: IceDatagramContext,
  currentGeneration: number,
): boolean {
  if (ctx.generation !== currentGeneration) {
    return false;
  }
  if (!ctx.authenticated || !ctx.pair) {
    return false;
  }
  if (ctx.protocol !== ctx.pair.protocol) {
    return false;
  }
  const remote = ctx.pair.remoteAddr;
  return ctx.source[0] === remote[0] && ctx.source[1] === remote[1];
}
