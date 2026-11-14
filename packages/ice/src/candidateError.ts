import {
  AddressFamilyMismatch,
  TransactionCancelled,
  TransactionFailed,
  TransactionIntegrityViolation,
  TransactionTimeout,
  TurnRedirectError,
} from "./exceptions";
import type { Address } from "./imports/common";

/**
 * One STUN/TURN server of a gathering, as configured. `urls` are the
 * application's names for the server (`IceOptions.stunServerUrls`,
 * `TurnServerOptions.urls`), passed through unchanged; they are metadata
 * only and never carry a credential.
 */
export type IceServerRef =
  | {
      kind: "stun";
      address: Address;
      /** The `stunServerUrls` entries of this address, when configured. */
      urls?: string[];
    }
  | {
      kind: "turn";
      address: Address;
      transport: "udp" | "tcp" | "tls";
      /** `TurnServerOptions.urls` of the server, passed through. */
      urls?: string[];
    };

/**
 * A STUN or TURN server a gathering used could not give a candidate
 * (`Connection.onIceCandidateError`). Reported at most once per server, local
 * socket and generation (a 701 once per server and generation, when no
 * socket reached it), only for the generation gathering and never after
 * close.
 */
export type IceCandidateErrorInfo = {
  server: IceServerRef;
  /** Local address used to contact the server; undefined when unknown or hidden. */
  address?: string;
  /** Local port; undefined when `address` is. */
  port?: number;
  /**
   * STUN error code (300-699) the server answered with, or
   * {@link IceCandidateErrorCode.SERVER_NOT_REACHED} (701) when no answer
   * came.
   */
  errorCode: number;
  /** Reason phrase; never contains credentials. */
  errorText: string;
  /** Gathering generation the failure belongs to. */
  generation: number;
};

/**
 * A STUN or TURN server a gathering used answered (`Connection
 * .onIceServerReached`): a STUN query or TURN allocation gave a candidate,
 * or the server answered with an error response (300-699). A server that
 * answered is reachable, so `icecandidateerror` reports no 701 for it.
 * Only for the generation gathering and never after close; a STUN server
 * may be reported once per local socket that reached it.
 */
export type IceServerReachedInfo = {
  server: IceServerRef;
  /** Gathering generation the answer belongs to. */
  generation: number;
};

/**
 * Error codes of {@link IceCandidateErrorInfo} besides the STUN ones
 * (W3C WebRTC §4.8.2: 701 when the server could not be reached).
 * @enum
 */
export const IceCandidateErrorCode = {
  SERVER_NOT_REACHED: 701,
} as const;
export type IceCandidateErrorCode =
  (typeof IceCandidateErrorCode)[keyof typeof IceCandidateErrorCode];

/**
 * A STUN Binding success response without XOR-MAPPED-ADDRESS: the server
 * answered but gave no server-reflexive address.
 */
export class MissingMappedAddressError extends Error {
  public addr: Address;

  constructor(addr: Address) {
    super(`STUN response from ${addr[0]}:${addr[1]} has no XOR-MAPPED-ADDRESS`);
    this.addr = addr;
  }
}

/** The STUN/TURN stage of the gathering the error came from. */
export type GatherErrorContext = {
  kind: "stun" | "turn";
  /** Transport toward the server (TURN); STUN queries are UDP. */
  transport?: "udp" | "tcp" | "tls";
};

const DNS_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "EAI_NODATA",
  "ENODATA",
  "ESERVFAIL",
  "ENONAME",
  "ETIMEOUT",
]);

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
]);

const SOCKET_ERROR_TEXTS: Record<string, string> = {
  EHOSTUNREACH: "Host unreachable",
  ENETUNREACH: "Network unreachable",
  EHOSTDOWN: "Host down",
  ENETDOWN: "Network down",
  EADDRNOTAVAIL: "Address not available",
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
};

const errnoOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};

const notReached = (errorText: string) => ({
  errorCode: IceCandidateErrorCode.SERVER_NOT_REACHED,
  errorText,
});

/**
 * The `errorCode` / `errorText` an application is told for a failed STUN
 * query or TURN allocation, or undefined when the failure is not reported
 * (a transaction cancelled by close).
 *
 * - an error response: its ERROR-CODE and reason phrase (a 300 whose
 *   redirect was not followed: 300 and the reason);
 * - no answer (timeout, DNS, address family, TCP / TLS connect, socket
 *   error): 701 and a fixed phrase naming the cause.
 *
 * The text never includes a username, password, realm or nonce.
 */
export function classifyGatherError(
  error: unknown,
  context: GatherErrorContext,
): { errorCode: number; errorText: string } | undefined {
  if (error instanceof TransactionCancelled) return undefined;

  if (error instanceof TurnRedirectError) {
    return { errorCode: 300, errorText: `Try Alternate (${error.reason})` };
  }
  if (error instanceof TransactionFailed) {
    const [code, reason] = error.response.getAttributeValue("ERROR-CODE") ?? [];
    if (typeof code === "number" && code >= 300 && code <= 699) {
      return {
        errorCode: code,
        errorText: typeof reason === "string" && reason ? reason : String(code),
      };
    }
    return notReached("STUN error response without a valid ERROR-CODE");
  }
  if (error instanceof TransactionIntegrityViolation) {
    return notReached("STUN response failed MESSAGE-INTEGRITY check");
  }
  if (error instanceof TransactionTimeout) {
    return notReached(
      context.kind === "stun"
        ? "STUN binding request timed out"
        : "TURN allocate request timed out",
    );
  }
  if (error instanceof AddressFamilyMismatch) {
    return notReached("No address of the socket family");
  }
  if (error instanceof MissingMappedAddressError) {
    return notReached("STUN response without XOR-MAPPED-ADDRESS");
  }

  const errno = errnoOf(error);
  if (errno && DNS_ERROR_CODES.has(errno)) {
    return notReached("Address resolution failed");
  }
  const stream = context.transport === "tcp" || context.transport === "tls";
  if (stream) {
    const message = error instanceof Error ? error.message : "";
    if (
      (errno && CONNECT_ERROR_CODES.has(errno)) ||
      /connect timed out/.test(message)
    ) {
      return notReached("TCP connect failed");
    }
  }
  if (errno && SOCKET_ERROR_TEXTS[errno]) {
    return notReached(SOCKET_ERROR_TEXTS[errno]);
  }
  if (context.transport === "tls") {
    return notReached("TLS handshake failed");
  }
  if (stream && errno) {
    return notReached(`TCP connect failed (${errno})`);
  }
  if (errno && /^E[A-Z]+$/.test(errno)) {
    return notReached(errno);
  }
  return notReached(
    context.kind === "stun"
      ? "STUN binding request failed"
      : "TURN allocate request failed",
  );
}

/**
 * Of the failures of the attempts at one TURN server (UDP, then the TCP
 * fallback), the one to report: a STUN error code the server answered with
 * wins over 701 (not reached); otherwise the last attempt's.
 */
export function pickReportedGatherError(
  failures: ({ errorCode: number; errorText: string } | undefined)[],
) {
  const reported = failures.filter(
    (failure): failure is { errorCode: number; errorText: string } =>
      failure !== undefined,
  );
  return (
    [...reported]
      .reverse()
      .find(
        (failure) =>
          failure.errorCode !== IceCandidateErrorCode.SERVER_NOT_REACHED,
      ) ?? reported[reported.length - 1]
  );
}
