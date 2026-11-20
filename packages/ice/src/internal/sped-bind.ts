/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 */
import type { Connection } from "../ice";
import type { SpedRuntime } from "../sped/runtime";

const runtimes = new WeakMap<Connection, SpedRuntime>();
const maybeFlush = new WeakMap<Connection, () => void>();
const spedEnabled = new WeakSet<Connection>();

/**
 * Mark a Connection whose peer connection opted into SPED
 * (`PeerConfig.sped`), before any check arrives. Only such a connection
 * applies the SPED request boundary: incoming Binding requests are
 * HMAC-verified (RFC 8445 §7.3) and an older generation's check never touches
 * the current checklist. Without it the ICE agent keeps its default request
 * handling.
 */
export function markConnectionSpedEnabled(connection: Connection): void {
  spedEnabled.add(connection);
}

/** Whether SPED was enabled for the connection (marked or attached). */
export function isConnectionSpedEnabled(connection: Connection): boolean {
  return spedEnabled.has(connection) || runtimes.has(connection);
}

export function setConnectionSpedRuntime(
  connection: Connection,
  runtime: SpedRuntime | undefined,
): void {
  if (runtime) {
    runtimes.set(connection, runtime);
  } else {
    runtimes.delete(connection);
  }
}

export function getConnectionSpedRuntime(
  connection: Connection,
): SpedRuntime | undefined {
  return runtimes.get(connection);
}

export function registerSpedCarryMaybeFlush(
  connection: Connection,
  flush: () => void,
): void {
  maybeFlush.set(connection, flush);
}

export function requestSpedCarryMaybeFlush(connection: Connection): void {
  maybeFlush.get(connection)?.();
}
