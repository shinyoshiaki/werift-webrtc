/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 */
import type { Connection } from "../ice";
import type { SpedRuntime } from "../sped/runtime";

const runtimes = new WeakMap<Connection, SpedRuntime>();
const maybeFlush = new WeakMap<Connection, () => void>();

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
