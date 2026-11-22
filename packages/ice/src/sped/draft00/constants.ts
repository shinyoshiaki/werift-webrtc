/**
 * IANA STUN attribute types for SPED draft-00.
 * draft-hancke-webrtc-sped-00 uses TBD names DTLS-IN-STUN-DATA / ACK;
 * wire values are IANA META-DTLS-IN-STUN / META-DTLS-IN-STUN-ACKNOWLEDGEMENT.
 */
export const DTLS_IN_STUN_DATA = 0xc070;
export const DTLS_IN_STUN_ACK = 0xc071;

/** RFC 9443 §3 / RFC 7983: DTLS content-type range (inclusive). */
export const DTLS_DEMUX_FIRST_BYTE_MIN = 20;
export const DTLS_DEMUX_FIRST_BYTE_MAX = 63;

/** draft §3.3.2.2 RECOMMENDED ACK count; this implementation hard-caps TX at 4. */
export const SPED_ACK_MAX = 4;

/** RFC 8831 typical DTLS MTU used as the STUN outer limit (draft §3.3.3). */
export const SPED_OUTER_MTU = 1200;
