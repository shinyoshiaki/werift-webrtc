/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 * The state lives on the connection ({@link Connection.internalSped}).
 */
import type { Connection } from "../ice";
import type { CandidatePair } from "../iceBase";
import { SpedSession } from "../sped/draft00/session";
import { isSpedAdvertisablePair, type SpedRuntime } from "../sped/runtime";
import type { Message } from "../stun/message";

/** SPED wiring of one Connection ({@link Connection.internalSped}). */
export type ConnectionSpedState = {
  /** PeerConfig.sped marked this connection before any check arrived. */
  enabled: boolean;
  /** The attached SPED controller. */
  runtime?: SpedRuntime;
  /**
   * Capability advertisement of an opted-in connection before its DTLS
   * transport attaches a runtime ({@link prepareConnectionSped}).
   */
  pendingAdvertisement?: SpedSession;
};

/** Advertise opt-in before gathering exposes a socket to early ICE checks. */
export function prepareConnectionSped(connection: Connection): void {
  connection.internalSped.pendingAdvertisement = new SpedSession(
    connection.generation,
  );
  // The opt-in also selects the SPED request boundary (see below).
  markConnectionSpedEnabled(connection);
}

/**
 * Called for Binding Requests and authenticated Binding Responses before DTLS
 * attaches. Advertise support without consuming or ACKing any received DTLS
 * flight: the sender must retain L1 until a live DTLS endpoint can receive it.
 * Every non-relay pair advertises (draft §3.3.2.1); the peer otherwise treats
 * a C070-less first authenticated Binding as unsupported.
 */
export function decoratePendingSped(
  connection: Connection,
  message: Message,
  pair: CandidatePair,
): boolean {
  const advertisement = connection.internalSped.pendingAdvertisement;
  if (!advertisement || !isSpedAdvertisablePair(pair)) {
    return true;
  }
  return advertisement.decorateCapabilityAdvertisement(message);
}

/**
 * Mark a Connection whose peer connection opted into SPED
 * (`PeerConfig.sped`), before any check arrives. Only such a connection
 * applies the SPED request boundary: incoming Binding requests are
 * HMAC-verified (RFC 8445 §7.3) and an older generation's check never touches
 * the current checklist. Without it the ICE agent keeps its default request
 * handling.
 */
export function markConnectionSpedEnabled(connection: Connection): void {
  connection.internalSped.enabled = true;
}

/** Whether SPED was enabled for the connection (marked or attached). */
export function isConnectionSpedEnabled(connection: Connection): boolean {
  return connection.internalSped.enabled || !!connection.internalSped.runtime;
}

export function setConnectionSpedRuntime(
  connection: Connection,
  runtime: SpedRuntime | undefined,
): void {
  connection.internalSped.pendingAdvertisement = undefined;
  connection.internalSped.runtime = runtime;
}

export function getConnectionSpedRuntime(
  connection: Connection,
): SpedRuntime | undefined {
  return connection.internalSped.runtime;
}
