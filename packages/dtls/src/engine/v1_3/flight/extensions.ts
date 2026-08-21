import { CookieExtension } from "../../../handshake/extensions/cookie";
import { EllipticCurves } from "../../../handshake/extensions/ellipticCurves";
import { EXT_EARLY_DATA, EXT_PADDING } from "../../../handshake/extensions/ids";
import { KeyShare } from "../../../handshake/extensions/keyShare";
import { SignatureAlgorithms } from "../../../handshake/extensions/signatureAlgorithms";
import { SupportedVersions } from "../../../handshake/extensions/supportedVersions";
import { UseSRTP } from "../../../handshake/extensions/useSrtp";

export { EXT_EARLY_DATA, EXT_PADDING } from "../../../handshake/extensions/ids";
export { assertUniqueExtensions } from "../../../handshake/extensions/unique";

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
