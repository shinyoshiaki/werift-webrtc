import type { Message } from "../stun/message";

/** Prefix of a NONCE that carries STUN Security Features (RFC 8489 §9.2). */
export const NONCE_COOKIE = "obMatJos2";

/** STUN Security Features a server announced in its nonce cookie. */
export interface NonceSecurityFeatures {
  /** Bit 0: PASSWORD-ALGORITHMS / PASSWORD-ALGORITHM negotiation. */
  passwordAlgorithms: boolean;
  /** Bit 1: USERHASH instead of USERNAME. */
  usernameAnonymity: boolean;
}

/**
 * Security Features of a NONCE that starts with the nonce cookie: "obMatJos2"
 * followed by 4 base64 characters encoding the 24-bit feature set
 * (RFC 8489 §9.2, §18.1). Undefined for a NONCE without the cookie, which
 * announces no feature.
 *
 * RFC 8489 numbers the bits from the most significant side in §9.2 and, as
 * corrected by erratum 6290, from the least significant side in §18.1. Both
 * readings are accepted so a feature is never missed: the client cannot use
 * either feature, and the other positions are unassigned.
 */
export function parseNonceSecurityFeatures(
  nonce: Buffer,
): NonceSecurityFeatures | undefined {
  const text = nonce.toString("latin1");
  if (!text.startsWith(NONCE_COOKIE)) {
    return undefined;
  }
  const encoded = text.slice(NONCE_COOKIE.length, NONCE_COOKIE.length + 4);
  // A malformed feature set cannot be trusted to announce nothing.
  if (!/^[A-Za-z0-9+/]{4}$/.test(encoded)) {
    return { passwordAlgorithms: true, usernameAnonymity: true };
  }
  const bits = Buffer.from(encoded, "base64").readUIntBE(0, 3);
  const bit = (n: number) =>
    (bits & (1 << n)) !== 0 || (bits & (1 << (23 - n))) !== 0;
  return { passwordAlgorithms: bit(0), usernameAnonymity: bit(1) };
}

/** The long-term credentials a request was sent with. */
export interface SentCredentials {
  /** The request carried MESSAGE-INTEGRITY. */
  authenticated: boolean;
  /** REALM the request was signed with, when authenticated. */
  realm?: string;
}

/** Realm and nonce to sign the retry of a challenged request with. */
export interface CredentialRetry {
  realm: string;
  nonce: Buffer;
}

/**
 * Decide whether a 401 (Unauthenticated) or 438 (Stale Nonce) error response
 * allows one retry with new credentials (RFC 8489 §9.2.5), and with which
 * realm and nonce. Undefined means the error is final.
 *
 * - NONCE is required, and Security Features the client does not implement
 *   (PASSWORD-ALGORITHMS, username anonymity) rule the retry out.
 * - 401 to an unauthenticated request (the first Allocate): retry with the
 *   REALM and NONCE of the response.
 * - 401 to an authenticated request: the username and password never change,
 *   so retrying with the same REALM is forbidden; only a new REALM is tried.
 * - 438: retry with the new NONCE and the current realm, which a REALM in
 *   the response must not contradict.
 */
export function credentialRetryOf(
  response: Message,
  sent: SentCredentials,
  currentRealm: string | undefined,
): CredentialRetry | undefined {
  const [errorCode] = response.getAttributeValue("ERROR-CODE") ?? [];
  if (errorCode !== 401 && errorCode !== 438) {
    return undefined;
  }

  const nonce: Buffer | undefined = response.getAttributeValue("NONCE");
  if (!nonce?.length) {
    return undefined;
  }
  const features = parseNonceSecurityFeatures(nonce);
  if (
    features &&
    (features.passwordAlgorithms ||
      features.usernameAnonymity ||
      response.getAttributeValue("PASSWORD-ALGORITHMS") !== undefined)
  ) {
    // Only MD5 MESSAGE-INTEGRITY with a plain USERNAME is implemented.
    return undefined;
  }

  const realm: string | undefined = response.getAttributeValue("REALM");
  if (errorCode === 401) {
    if (!realm) {
      return undefined;
    }
    if (sent.authenticated && realm === sent.realm) {
      return undefined;
    }
    return { realm, nonce };
  }

  if (!currentRealm || (realm !== undefined && realm !== currentRealm)) {
    return undefined;
  }
  return { realm: currentRealm, nonce };
}
