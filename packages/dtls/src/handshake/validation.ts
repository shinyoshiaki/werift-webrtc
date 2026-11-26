/**
 * How strictly the DTLS 1.2 path validates handshake messages
 * ({@link Options.handshakeValidation}).
 *
 * - `"standard"`: RFC-strict. A ClientHello with a malformed
 *   `supported_versions` is answered with a `protocol_version` alert (as one
 *   without an overlapping version always is), and duplicate extensions and
 *   a malformed `use_srtp` (profile list / MKI length) fail the handshake.
 * - `"lenient"` (default): the DTLS 1.2 behavior before these checks. A
 *   malformed `supported_versions` is ignored (DTLS 1.2 is negotiated when
 *   this side offers it; a well-formed list without an overlap still fails
 *   with `protocol_version`), duplicate extensions are not rejected, and
 *   `use_srtp` is read without length checks.
 *
 * Handshake fragments are always reassembled only once every byte was
 * received (`HandshakeReassembler`), whatever the mode. The DTLS 1.3 engine
 * always validates strictly.
 * @enum
 */
export const HandshakeValidation = {
  standard: "standard",
  lenient: "lenient",
} as const;
export type HandshakeValidation =
  (typeof HandshakeValidation)[keyof typeof HandshakeValidation];

/** Whether `validation` selects the strict ("standard") checks. */
export function isStandardHandshakeValidation(
  validation: HandshakeValidation | undefined,
): boolean {
  return validation === HandshakeValidation.standard;
}
