import { DtlsContext } from "../../context/dtls";
import { TransportContext } from "../../context/transport";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { Flight } from "../flight";

export class Flight3 extends Flight {
  constructor(udp: TransportContext, dtls: DtlsContext) {
    super(udp, dtls, 3, 5);
  }

  async exec(verifyReq: ServerHelloVerifyRequest) {
    if (this.dtls.flight === 3) throw new Error();
    this.dtls.flight = 3;

    this.dtls.handshakeCache = [];

    const clientHello = this.dtls.lastFlight[0] as ClientHello;
    clientHello.cookie = verifyReq.cookie;

    const packets = this.createPacket([clientHello]);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    await this.transmit([buf]);
  }
}
