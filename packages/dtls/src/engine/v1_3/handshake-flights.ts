/**
 * DTLS 1.3 handshake flight stack (index.ts Figure 3).
 *
 * Split like DTLS 1.2 (`src/flight/{client,server}/flightN.ts`):
 *   flight/dispatch.ts          — message order + dispatch
 *   flight/extensions.ts        — extension allowlists / uniqueness
 *   flight/certificate.ts       — Certificate / CertificateVerify (both roles)
 *   flight/finished.ts          — Finished role dispatch
 *   flight/post-hs.ts           — KeyUpdate
 *   flight/client/flight1.ts    — ClientHello (Flight 1/3)
 *   flight/client/flight4.ts    — ServerHello / EE / CertificateRequest
 *   flight/client/flight5.ts    — client Finished + optional client cert
 *   flight/server/flight2.ts    — HelloRetryRequest
 *   flight/server/flight4.ts    — onClientHello + server encrypted flight
 *   flight/server/flight5.ts    — server receives client Finished
 */
export { Dtls13PostHandshake as Dtls13HandshakeFlights } from "./flight/post-hs";
