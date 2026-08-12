import type { DtlsContext } from "../../context/dtls";
import type { TransportContext } from "../../context/transport";
import type { ClientHello } from "../../handshake/message/client/hello";
import type { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { debug } from "../../imports/common";
import { Flight } from "../flight";

const log = debug(
  "werift-dtls : packages/dtls/src/flight/client/flight3.ts : log",
);

export class Flight3 extends Flight {
  constructor(udp: TransportContext, dtls: DtlsContext) {
    super(udp, dtls, 3, 5);
  }

  /**
   * Process HelloVerifyRequest: attach cookie and send ClientHello2.
   *
   * RFC 6347: clients should tolerate multiple HVRs (re-challenge on invalid /
   * expired cookie, server restart, address change). First HVR arrives while
   * flight is still 1; a re-challenge HVR arrives while flight is 3 (waiting
   * for Flight4). Do not throw on the second case.
   */
  async exec(verifyReq: ServerHelloVerifyRequest) {
    // After ServerHello path advanced, ignore late HVR.
    if (this.dtls.flight > 3) {
      log(
        this.dtls.sessionId,
        "ignore HelloVerifyRequest after flight advanced",
        this.dtls.flight,
      );
      return;
    }

    const rechallenge = this.dtls.flight === 3;
    this.dtls.flight = 3;

    // Clear local handshake cache for a fresh CH2 transmission.
    // (Object map — do not assign [].)
    this.dtls.handshakeCache = {};

    const [clientHello] = this.dtls.lastFlight as [ClientHello];
    if (!clientHello) {
      throw new Error("Flight3: no ClientHello in lastFlight for HVR cookie");
    }
    log(
      this.dtls.sessionId,
      rechallenge ? "HVR re-challenge" : "HVR first",
      "dtls version",
      clientHello.clientVersion,
    );
    clientHello.cookie = verifyReq.cookie;
    this.dtls.cookie = verifyReq.cookie;

    const packets = this.createPacket([clientHello]);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    await this.transmit([buf]);
  }
}
