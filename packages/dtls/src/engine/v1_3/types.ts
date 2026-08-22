/**
 * DTLS 1.3 engine shared types and constants.
 * See packages/dtls/src/index.ts Figure 3 for the flight sequence.
 */
import type { DtlsHandshakeCarrier } from "../../carrier/types";
import type { NamedCurveAlgorithms } from "../../cipher/const";
import type { Transport } from "../../imports/common";
import { debug } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import type { AddressValidationMode, PeerIdentityMode } from "../../peer";
import type { DtlsVersion } from "../../version";

/** Anti-amplification: server may send at most 3× received before address validated. */
export const ANTI_AMPLIFICATION_FACTOR = 3;

export {
  DTLS_SRTP_INITIAL_RTO_MS,
  INITIAL_RTO_MS,
  MAX_RTO_MS,
  MIN_RTO_MS,
  RTO_FACTOR,
  computeDtlsRtoMs,
} from "../../retransmission";

/**
 * Pre-cookie HRR attempt table (per source 5-tuple). Bounded so spoofed CH
 * floods cannot grow unbounded server state (RFC 9147 cookie exchange).
 */
export const MAX_PRE_COOKIE_ATTEMPTS = 64;
export const PRE_COOKIE_ATTEMPT_TTL_MS = 30_000;

/** Fragment reassembly limits (RFC 9147: bound memory against abuse). */
export const MAX_HS_MESSAGE_BYTES = 64 * 1024;
export const MAX_FRAGMENT_BUFFER_MESSAGES = 8;
export const MAX_FRAGMENT_BUFFER_BYTES = 128 * 1024;
export const MAX_FRAGMENTS_PER_MESSAGE = 64;
export const FRAGMENT_TTL_MS = 30_000;

/** Post-handshake / KeyUpdate epoch retention (time + count). */
export const MAX_RETAINED_APP_EPOCHS = 4;
export const EPOCH_KEY_TTL_MS = 60_000;
/** How often to run idle epoch TTL prune (timer-driven, not only on epoch ops). */
export const EPOCH_PRUNE_INTERVAL_MS = 5_000;
/**
 * Soft upper bound on ACK record_numbers (also clamped by dynamic MTU).
 * Intermediate ACKs are flushed before this is exceeded so large flights
 * (e.g. fragmented Certificate) remain fully ACKable.
 */
export const MAX_ACK_RECORD_NUMBERS = 32;
/**
 * Cap of successfully accepted handshake records tracked for replay re-ACK.
 * Must cover a full multi-fragment flight (64 frags + CV + Finished).
 */
export const MAX_ACCEPTED_HS_RECORDS = 128;
/** Encrypted ACK record overhead: unified hdr(5) + inner CT(1) + list len(2) + GCM tag(16). */
export const ACK_ENCRYPTED_OVERHEAD = 5 + 1 + 2 + 16;
/** Plaintext ACK record overhead: DTLSPlaintext hdr(13) + list len(2). */
export const ACK_PLAINTEXT_OVERHEAD = 13 + 2;
/** Bytes per RecordNumber on the wire. */
export const ACK_RECORD_NUMBER_BYTES = 16;

/**
 * Default early epoch-3 app-data reorder buffer (record count).
 *
 * RFC 9147 allows buffering or discarding application data that arrives
 * before the handshake is marked complete. The default is sized for WebRTC
 * DataChannel over SCTP: werift's default `maxMessageSize` is 64 KiB, and
 * SCTP DATA chunks are typically ~1 KiB after DTLS/SCTP headers, so one
 * message is ~64 records plus INIT/COOKIE and a reorder burst. 256 leaves
 * comfortable headroom without an unbounded pre-Finished buffer.
 *
 * Override via {@link Dtls13Options.maxEarlyAppDataRecords} /
 * `Options.maxEarlyAppDataRecords`.
 */
export const MAX_EARLY_APP_DATA_RECORDS = 256;
/**
 * Default early epoch-3 app-data reorder buffer (bytes).
 * 256 KiB covers the 64 KiB DataChannel default plus SCTP overhead and a
 * couple of back-to-back messages.
 */
export const MAX_EARLY_APP_DATA_BYTES = 256 * 1024;
/**
 * Opt-in unbounded early-app-data buffer for trusted P2P paths.
 * Pass as `maxEarlyAppDataRecords` / `maxEarlyAppDataBytes`.
 * There is no hidden ceiling — the association will buffer until `onConnect`.
 */
export const EARLY_APP_DATA_UNLIMITED = Number.POSITIVE_INFINITY;

function resolveEarlyAppDataLimit(
  name: string,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (value === EARLY_APP_DATA_UNLIMITED) return EARLY_APP_DATA_UNLIMITED;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer or EARLY_APP_DATA_UNLIMITED`,
    );
  }
  return value;
}

/** Resolve the early-app-data record cap from options or the DataChannel default. */
export function resolveMaxEarlyAppDataRecords(value?: number): number {
  return resolveEarlyAppDataLimit(
    "maxEarlyAppDataRecords",
    value,
    MAX_EARLY_APP_DATA_RECORDS,
  );
}

/** Resolve the early-app-data byte cap from options or the DataChannel default. */
export function resolveMaxEarlyAppDataBytes(value?: number): number {
  return resolveEarlyAppDataLimit(
    "maxEarlyAppDataBytes",
    value,
    MAX_EARLY_APP_DATA_BYTES,
  );
}

export const log = debug("werift-dtls : packages/dtls/src/engine/v1_3");

export type {
  AddressValidationMode,
  PeerIdentityMode,
} from "../../peer";
export { associationHasPeerAuth, resolvePeerIdentityMode } from "../../peer";

export interface Dtls13Options {
  transport: Transport;
  /**
   * Optional handshake carrier (transport-independent). When omitted, a
   * DirectHandshakeCarrier is created from `transport`. Inject a custom
   * carrier for SPED / external retransmission tests (Epic 2).
   */
  carrier?: DtlsHandshakeCarrier;
  /**
   * Server certificate (required for servers).
   * Client: optional for server-auth-only; required when peer sends CertificateRequest.
   */
  cert?: string;
  /** Matching private key for `cert`. */
  key?: string;
  srtpProfiles?: SrtpProfile[];
  certificateRequest?: boolean;
  /** Preferred named groups order */
  groups?: NamedCurveAlgorithms[];
  mtu?: number;
  /**
   * Max epoch-3 application-data records buffered before markConnected
   * (UDP reorder / 0.5-RTT). Default {@link MAX_EARLY_APP_DATA_RECORDS} (256).
   * Sized for WebRTC DataChannel. Use {@link EARLY_APP_DATA_UNLIMITED} on
   * trusted P2P paths (no ceiling).
   */
  maxEarlyAppDataRecords?: number;
  /**
   * Max bytes of epoch-3 application data buffered before markConnected.
   * Default {@link MAX_EARLY_APP_DATA_BYTES} (256 KiB).
   * Use {@link EARLY_APP_DATA_UNLIMITED} on trusted P2P paths (no ceiling).
   */
  maxEarlyAppDataBytes?: number;
  /**
   * Address validation policy.
   * - dtls-cookie (default): HRR + cookie before amplifying server flight
   * - ice-authenticated / none: skip cookie (peer path already authenticated)
   */
  addressValidation?: AddressValidationMode;
  /**
   * Peer-identity policy for association RX demux / lifecycle.
   * Default: inferred from transport.peerAuthenticated / addressValidation.
   * Must match association Options.peerIdentityMode when engine is nested.
   */
  peerIdentityMode?: PeerIdentityMode;
  /**
   * Versions advertised in ClientHello supported_versions (preference order).
   * Default: `[V1_3]` only. Dual-stack association passes `[V1_3, V1_2]` etc.
   */
  offeredProtocolVersions?: readonly DtlsVersion[];
}
export type Role = "client" | "server";

/** HelloRetryRequest special random (RFC 8446). */
export const HRR_RANDOM = Buffer.from(
  "CF21AD74E59A6111BE1D8C021E65B891C2A211167ABB8C5E079E09E2C8A8339C",
  "hex",
);
