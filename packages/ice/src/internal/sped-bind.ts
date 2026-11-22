/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 * The state lives on the connection ({@link Connection.internalSped}).
 */
import type { Connection } from "../ice";
import type { SpedRuntime } from "../sped/runtime";

/** SPED wiring of one Connection ({@link Connection.internalSped}). */
export type ConnectionSpedState = {
  /** PeerConfig.sped marked this connection before any check arrived. */
  enabled: boolean;
  /** The attached SPED controller. */
  runtime?: SpedRuntime;
  /** Lets a SPED DATA response trigger one more Binding (ICE-Lite peers). */
  carryMaybeFlush?: () => void;
};

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
  connection.internalSped.runtime = runtime;
}

export function getConnectionSpedRuntime(
  connection: Connection,
): SpedRuntime | undefined {
  return connection.internalSped.runtime;
}

export function registerSpedCarryMaybeFlush(
  connection: Connection,
  flush: () => void,
): void {
  connection.internalSped.carryMaybeFlush = flush;
}

export function requestSpedCarryMaybeFlush(connection: Connection): void {
  connection.internalSped.carryMaybeFlush?.();
}
