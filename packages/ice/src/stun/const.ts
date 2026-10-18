export * from "../../../ice-server/src/stun/const";

/**
 * Response deadline for ICE connectivity checks over TCP (RFC 6544).
 * Reliable transports send each STUN request once (RFC 5389 §7.2.2), so this
 * single wait has to cover the TCP connect of an active candidate as well as
 * the request/response round trip on a loaded host.
 */
export const TCP_CHECK_RESPONSE_TIMEOUT_MS = 3000;
