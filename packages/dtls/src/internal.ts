/**
 * @internal
 * Non-public factories for unit tests and Epic 2 SPED carrier injection.
 * Not re-exported from package root (`src/index.ts`).
 */
import { DtlsClient, type DualAssociationPhase } from "./client";
import { EarlyDataBuffer } from "./engine/v1_3/early-data-buffer";
import { EARLY_DATA_LIMITS } from "./engine/v1_3/types";
import { DtlsServer } from "./server";
import type { DtlsInternalOptions, DtlsSocket, Options } from "./socket";
export { EarlyDataBuffer, EARLY_DATA_LIMITS };
export type { EarlyDataBufferStats } from "./engine/v1_3/early-data-buffer";
export type { DtlsReadiness } from "./engine/v1_3/types";

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

/**
 * @internal Dual association phase observation for e2e (avoids `(client as any).dualPhase`).
 */
export function dualAssociationPhaseOf(
  client: DtlsClient,
): DualAssociationPhase {
  return client.dualAssociationPhase;
}

// Re-export type for tests without promoting it through package root.
export type { DtlsInternalOptions, DualAssociationPhase };

/**
 * @internal Rebuild pending handshake datagrams after SPED path MTU shrinks.
 * Not part of the DtlsClient / DtlsServer public API.
 */
export function refragmentPendingFlightIfNeeded(socket: DtlsSocket): boolean {
  const engine = (
    socket as unknown as {
      engine13?: { refragmentPendingFlightIfNeeded(): boolean };
    }
  ).engine13;
  return engine?.refragmentPendingFlightIfNeeded() ?? false;
}

/**
 * @internal Pre-authentication buffer using {@link EARLY_DATA_LIMITS}.
 * `enabled: false` creates a zero-capacity buffer that drops every push
 * (used when early media buffering is not opted in).
 */
export function createPreAuthEarlyDataBuffer({
  enabled = true,
}: { enabled?: boolean } = {}): EarlyDataBuffer {
  return new EarlyDataBuffer(
    enabled ? EARLY_DATA_LIMITS.maxRecords : 0,
    enabled ? EARLY_DATA_LIMITS.maxBytes : 0,
    EARLY_DATA_LIMITS.retentionMs,
  );
}
