/**
 * TLS/DTLS extension type numbers used without a dedicated handshake class
 * (RFC 7685 padding, RFC 8446 early_data). Other types live on their classes
 * (e.g. {@link CookieExtension.type}, {@link KeyShare.type}).
 */
export const EXT_PADDING = 21;
export const EXT_EARLY_DATA = 42;
