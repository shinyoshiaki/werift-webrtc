import { CookieExtension } from "../../../handshake/extensions/cookie";
import { EllipticCurves } from "../../../handshake/extensions/ellipticCurves";
import { KeyShare } from "../../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../../handshake/extensions/useSrtp";
import { AlertDesc } from "../../../record/const";
import { DtlsProtocolError } from "../../../version";

/** TLS 1.3 extension type padding (RFC 7685) — may change after HRR. */
export const EXT_PADDING = 21;
/** TLS 1.3 early_data — must be removed in ClientHello2 if present in CH1. */
export const EXT_EARLY_DATA = 42;

/** ServerHello (final) allowed extensions when PSK is not negotiated. */
export const SERVER_HELLO_ALLOWED_EXTS = new Set([
  SupportedVersions.type,
  KeyShare.type,
]);
/** HelloRetryRequest allowed extensions. */
export const HRR_ALLOWED_EXTS = new Set([
  SupportedVersions.type,
  KeyShare.type,
  CookieExtension.type,
]);
/**
 * Known extensions that are legal in EncryptedExtensions (TLS 1.3 registry).
 * Known types outside this set in EE → illegal_parameter.
 */
export const EE_KNOWN_ALLOWED_EXTS = new Set([
  EllipticCurves.type, // 10 supported_groups (CH, EE)
  UseSRTP.type, // 14 use_srtp (CH, EE)
]);
/** Known TLS 1.3 extension types we parse (for wrong-message rejection). */
export const KNOWN_EXTENSION_TYPES = new Set([
  EllipticCurves.type, // 10 supported_groups
  SignatureAlgorithms.type, // 13
  UseSRTP.type, // 14
  EXT_PADDING, // 21
  SupportedVersions.type, // 43
  CookieExtension.type, // 44
  KeyShare.type, // 51
  EXT_EARLY_DATA, // 42
]);

/**
 * RFC 8446: There MUST NOT be more than one extension of the same type
 * in a given extension block.
 */
export function assertUniqueExtensions(
  extensions: { type: number }[],
  context: string,
): void {
  const seen = new Set<number>();
  for (const e of extensions) {
    if (seen.has(e.type)) {
      throw new DtlsProtocolError(
        `illegal_parameter: duplicate extension 0x${e.type.toString(16)} in ${context}`,
        AlertDesc.IllegalParameter,
      );
    }
    seen.add(e.type);
  }
}
