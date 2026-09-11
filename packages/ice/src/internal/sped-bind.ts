/**
 * Package-private SPED attachment for Connection. Not exported from src/index.ts.
 */
import type { Connection } from "../ice";
import type { SpedRuntime } from "../sped/runtime";

const runtimes = new WeakMap<Connection, SpedRuntime>();

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
