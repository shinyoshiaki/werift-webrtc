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

  async exec(verifyReq: ServerHelloVerifyRequest) {
    if (this.dtls.flight === 3) throw new Error();
    this.dtls.flight = 3;

    this.dtls.handshakeCache = [];

    const [clientHello] = this.dtls.lastFlight as [ClientHello];
    log("dtls version", clientHello.clientVersion);
    clientHello.cookie = verifyReq.cookie;
    this.dtls.cookie = verifyReq.cookie;

    const packets = this.createPacket([clientHello]);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    await this.transmit([buf]);
  }
}
