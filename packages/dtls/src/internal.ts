/**
 * @internal
 * Non-public factories for unit tests and Epic 2 SPED carrier injection.
 * Not re-exported from package root (`src/index.ts`).
 */
import { DtlsClient } from "./client";
import { DtlsServer } from "./server";
import type { DtlsInternalOptions, Options } from "./socket";

/**
 * @internal Create a DtlsClient with internal-only options (e.g. handshakeCarrier).
 * Application code must use `new DtlsClient(options: Options)`.
 */
export function createDtlsClientInternal(
  options: DtlsInternalOptions,
): DtlsClient {
  // Internal cast: constructor surface stays Options-only for Public API / docs.
  return new DtlsClient(options as Options);
}

/**
 * @internal Create a DtlsServer with internal-only options (e.g. handshakeCarrier).
 * Application code must use `new DtlsServer(options: Options)`.
 */
export function createDtlsServerInternal(
  options: DtlsInternalOptions,
): DtlsServer {
  return new DtlsServer(options as Options);
}

// Re-export type for tests without promoting it through package root.
export type { DtlsInternalOptions };
