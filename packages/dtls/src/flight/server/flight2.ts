import type { DtlsContext } from "../../context/dtls";
import type { TransportContext } from "../../context/transport";
import {
  mintDtls12HelloVerifyCookie,
  peerKeyFromAddr,
} from "../../handshake/extensions/cookie";
import type { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import type { Address } from "../../imports/common";
import { debug } from "../../imports/rtp";
import { createFragments, createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";

const log = debug("werift-dtls : packages/dtls/flight/server/flight2.ts : log");

// HelloVerifyRequest does not retransmit (RFC 6347: client retransmits CH1)

/**
 * Flight 2: HelloVerifyRequest only.
 *
 * Pre-cookie: must NOT commit association crypto state (random, ECDHE, suite,
 * SRTP, EMS). Cookie is HMAC-bound to source address + ClientHello parameters
 * (excluding legacy_cookie) so a different peer cannot reuse it and concurrent
 * cookie-less CH from B cannot poison A's pending handshake.
 */
export const flight2 =
  (udp: TransportContext, dtls: DtlsContext) =>
  (clientHello: ClientHello, dest?: Address, clientHelloMessageSeq = 0) => {
    log("dtls version", clientHello.clientVersion);

    dtls.flight = 2;

    // Handshake message_seq tracks the ClientHello we are answering
    // (CH1=0 → HVR=0; re-challenge CH2=1 → HVR=1). Errata 5186: RFC 6347's
    // "record sequence number" wording here means handshake message_seq.
    // Epoch-0 record sequence must keep increasing — never rewind — or a
    // replay window will discard HVR2 as a duplicate of HVR1.
    dtls.sequenceNumber = clientHelloMessageSeq;

    const peerKey = peerKeyFromAddr(dest);
    const chBody = clientHello.serialize();
    const cookie = mintDtls12HelloVerifyCookie(
      dtls.cookieSecret,
      peerKey,
      chBody,
    );
    // sessionId display only — not used for verification (stateless HMAC cookie)
    dtls.cookie = cookie;

    const helloVerifyReq = new ServerHelloVerifyRequest(
      {
        major: 255 - 1,
        minor: 255 - 2,
      },
      cookie,
    );
    const fragments = createFragments(dtls)([helloVerifyReq]);
    const packets = createPlaintext(dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++dtls.recordSequenceNumber,
    );

    const chunk = packets.map((v) => v.serialize());
    // Explicit dest freezes the ClientHello source across async handleHandshakes
    // so concurrent spoof RX cannot redirect HVR via mutable transport.rinfo.
    for (const buf of chunk) {
      udp.send(buf, dest);
    }
  };
