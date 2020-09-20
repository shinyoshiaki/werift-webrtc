import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { createFragments, createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";
import { Flight } from "../flight";

export class Flight3 extends Flight {
  constructor(udp: TransportContext, dtls: DtlsContext) {
    super(udp, dtls, 5);
  }

  exec(verifyReq: ServerHelloVerifyRequest) {
    if (this.dtls.flight === 3) return;
    this.dtls.flight = 3;

    const hello = this.dtls.lastFlight[0] as ClientHello;
    hello.cookie = verifyReq.cookie;
    const fragments = createFragments(this.dtls)([hello]);
    this.dtls.handshakeCache = [];
    this.dtls.bufferHandshakeCache(fragments, true, 3);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.transmit([buf]);
  }
}
