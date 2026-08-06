export enum HandshakeType {
  hello_request_0 = 0,
  client_hello_1 = 1,
  server_hello_2 = 2,
  hello_verify_request_3 = 3,
  /** TLS 1.3 NewSessionTicket */
  new_session_ticket_4 = 4,
  /** TLS 1.3 EndOfEarlyData */
  end_of_early_data_5 = 5,
  /** TLS 1.3 EncryptedExtensions */
  encrypted_extensions_8 = 8,
  certificate_11 = 11,
  server_key_exchange_12 = 12,
  certificate_request_13 = 13,
  server_hello_done_14 = 14,
  certificate_verify_15 = 15,
  client_key_exchange_16 = 16,
  finished_20 = 20,
  /** TLS 1.3 KeyUpdate */
  key_update_24 = 24,
  /** TLS 1.3 MessageHash (HRR transcript) */
  message_hash_254 = 254,
}
