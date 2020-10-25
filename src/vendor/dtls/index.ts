export { createUdpTransport, Transport, UdpTransport } from "./transport";
export { DtlsSocket } from "./socket";
export { DtlsServer } from "./server";
export { DtlsClient } from "./client";

/* Client                                          Server
   ------                                          ------

   ClientHello             -------->                           Flight 1

						   <-------    HelloVerifyRequest      Flight 2

   ClientHello             -------->                           Flight 3

											  ServerHello    \
											 Certificate*     \
									   ServerKeyExchange*      Flight 4
									  CertificateRequest*     /
						   <--------      ServerHelloDone    /

   Certificate*                                              \
   ClientKeyExchange                                          \
   CertificateVerify*                                          Flight 5
   [ChangeCipherSpec]                                         /
   Finished                -------->                         /

									   [ChangeCipherSpec]    \ Flight 6
						   <--------             Finished    /

			   Figure 1. Message Flights for Full Handshake

=======================================================================

   Client                                           Server
   ------                                           ------

   ClientHello             -------->                          Flight 1

											  ServerHello    \
									   [ChangeCipherSpec]     Flight 2
							<--------             Finished    /

   [ChangeCipherSpec]                                         \Flight 3
   Finished                 -------->                         /

		 Figure 2. Message Flights for Session-Resuming Handshake
						   (No Cookie Exchange)
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
