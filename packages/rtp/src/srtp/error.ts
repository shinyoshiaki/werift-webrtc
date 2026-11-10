export class SrtpAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SrtpAuthenticationError";
  }
}

/**
 * A packet whose SRTP/SRTCP index was already received, or is older than the
 * replay window (RFC 3711 §3.3.2). Subclasses SrtpAuthenticationError so
 * receivers that drop unauthenticated packets drop replays the same way.
 */
export class SrtpReplayError extends SrtpAuthenticationError {
  constructor(message: string) {
    super(message);
    this.name = "SrtpReplayError";
  }
}
