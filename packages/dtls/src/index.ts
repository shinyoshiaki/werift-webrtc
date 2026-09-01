export * from "./context/cipher";
export * from "./context/srtp";
export * from "./cipher/const";
export { DtlsClient } from "./client";
export { DtlsServer } from "./server";
export { DtlsSocket, DtlsVersion } from "./socket";
export type { Options } from "./socket";
export type { PeerIdentityMode } from "./peer";
export { EARLY_APP_DATA_UNLIMITED } from "./engine/v1_3/types";
// DtlsInternalOptions / createDtls*Internal are intentionally NOT exported
// (not stable Public API). Import from "./internal" only in tests / Epic 2.
export { ProtocolVersionError } from "./version";
// selectVersion / DtlsVersionSelected are association-internal (not Public API).
// Carrier / SPED types are package-internal for Epic 1.

/*
 * DTLS 1.2 full handshake (RFC 6347) — default when protocolVersions is unset
 * -------------------------------------------------------------------------
 * Client                                          Server
 * ------                                          ------
 *
 * ClientHello             -------->                           Flight 1
 *
 *                         <-------    HelloVerifyRequest      Flight 2
 *
 * ClientHello             -------->                           Flight 3
 *
 *                                           ServerHello    \
 *                                          Certificate*     \
 *                                    ServerKeyExchange*      Flight 4
 *                                   CertificateRequest*     /
 *                         <--------      ServerHelloDone    /
 *
 * Certificate*                                              \
 * ClientKeyExchange                                          \
 * CertificateVerify*                                          Flight 5
 * [ChangeCipherSpec]                                         /
 * Finished                -------->                         /
 *
 *                                    [ChangeCipherSpec]    \ Flight 6
 *                         <--------             Finished    /
 *
 *            Figure 1. Message Flights for Full Handshake (DTLS 1.2)
 *
 * =======================================================================
 *
 * Client                                           Server
 * ------                                           ------
 *
 * ClientHello             -------->                          Flight 1
 *
 *                                           ServerHello    \
 *                                    [ChangeCipherSpec]     Flight 2
 *                         <--------             Finished    /
 *
 * [ChangeCipherSpec]                                         \Flight 3
 * Finished                 -------->                         /
 *
 *      Figure 2. Session-Resuming Handshake (DTLS 1.2, no cookie)
 *
 * =======================================================================
 *
 * DTLS 1.3 full handshake (RFC 9147) — opt-in via protocolVersions: [V1_3]
 * -------------------------------------------------------------------------
 * Client                                           Server
 * ------                                           ------
 *
 * ClientHello + key_share     -------->                    Flight 1
 *   supported_versions
 *   (optional: early_data)
 *
 *   [optional address validation / group select — single HRR]
 *                             <--------   HelloRetryRequest  Flight 2
 *                                           (cookie* and/or
 *                                            selected_group*)
 *
 * ClientHello + cookie*       -------->                    Flight 3
 *   key_share (updated)
 *
 *                             <--------   ServerHello        \
 *                                           + key_share       \
 *                                         {EncryptedExtensions}\ Flight 4
 *                                         {CertificateRequest*}\
 *                                         {Certificate}        /
 *                                         {CertificateVerify} /
 *                                         {Finished}         /
 *
 *   [optional: ACK for server flight]
 *
 * {Certificate*}              -------->                    Flight 5
 * {CertificateVerify*}
 * {Finished}
 *
 *                             <--------   [ACK]              (post-HS)
 *
 *            [Application Data <-------> Application Data]
 *
 *   { }  = encrypted with handshake traffic keys (epoch 2)
 *   *    = optional (cookie, mutual auth, HRR)
 *
 *   Post-handshake (after connected):
 *     either side may send {KeyUpdate}; peer replies with ACK
 *     before the sender uses the new application write keys.
 *     servers may send {NewSessionTicket}; client ACKs and discards
 *     (no PSK / resumption).
 *
 *            Figure 3. Message Flights for Full Handshake (DTLS 1.3)
 *
 * Implementation map (packages/dtls/src/engine/v1_3/):
 *   Flight 1/3 ClientHello     → flight/client/flight1.ts (sendClientHello)
 *   Flight 2   HelloRetryRequest* → flight/server/flight2.ts (sendHelloRetryRequest)
 *   Flight 4   ServerHello+{…} → flight/server/flight4.ts + flight/client/flight4.ts
 *   Flight 5   client {Finished} → flight/client/flight5.ts / flight/server/flight5.ts
 *   Post-HS    KeyUpdate / NewSessionTicket / ACK → flight/post-hs.ts + flight-tx.ts + record-rx.ts
 *   Wire I/O   records/flights → record-rx.ts (in) / flight-tx.ts (out)
 *   Host       Dtls13Connection extends Dtls13ConnectionBase once;
 *              flight/record modules are functions (this: Dtls13Host)
 *   See also engine/v1_3/README.md and engine/v1_3/AGENTS.md
 */

// enum HandshakeType {
//   hello_request = 0,
//   client_hello = 1,
//   server_hello = 2,
//   hello_verify_request = 3,
//   certificate = 11,
//   server_key_exchange = 12,
//   certificate_request = 13,
//   server_hello_done = 14,
//   certificate_verify = 15,
//   client_key_exchange = 16,
//   finished = 20,
// }

// enum ContentType {
//   changeCipherSpec = 20,
//   alert = 21,
//   handshake = 22,
//   applicationData = 23,
// }

// enum {
//   close_notify(0),
//   unexpected_message(10),
//   bad_record_mac(20),
//   decryption_failed_RESERVED(21),
//   record_overflow(22),
//   decompression_failure(30),
//   handshake_failure(40),
//   no_certificate_RESERVED(41),
//   bad_certificate(42),
//   unsupported_certificate(43),
//   certificate_revoked(44),
//   certificate_expired(45),
//   certificate_unknown(46),
//   illegal_parameter(47),
//   unknown_ca(48),
//   access_denied(49),
//   decode_error(50),
//   decrypt_error(51),
//   export_restriction_RESERVED(60),
//   protocol_version(70),
//   insufficient_security(71),
//   internal_error(80),
//   user_canceled(90),
//   no_renegotiation(100),
//   unsupported_extension(110),
//   (255)
// } AlertDescription;
