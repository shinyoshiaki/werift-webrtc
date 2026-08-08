/**
 * DTLS 1.3 engine shared types and constants.
 * See packages/dtls/src/index.ts Figure 3 for the flight sequence.
 */
import type { NamedCurveAlgorithms } from "../../cipher/const";
import type { Transport } from "../../imports/common";
import { debug } from "../../imports/common";
import type { SrtpProfile } from "../../imports/rtp";
import type { DtlsVersion } from "../../version";

/** Anti-amplification: server may send at most 3× received before address validated. */
export const ANTI_AMPLIFICATION_FACTOR = 3;

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
/** RFC 9147 ACK record_numbers list upper bound (bytes ≈ 16 * N). */
export const MAX_ACK_RECORD_NUMBERS = 32;
/** Cap of successfully accepted handshake records tracked for replay re-ACK. */
export const MAX_ACCEPTED_HS_RECORDS = 64;

export const log = debug("werift-dtls : packages/dtls/src/engine/v1_3");

export type AddressValidationMode =
  | "dtls-cookie"
  | "ice-authenticated"
  | "none";

export interface Dtls13Options {
  transport: Transport;
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
   * Address validation policy.
   * - dtls-cookie (default): HRR + cookie before amplifying server flight
   * - ice-authenticated / none: skip cookie (peer path already authenticated)
   */
  addressValidation?: AddressValidationMode;
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
