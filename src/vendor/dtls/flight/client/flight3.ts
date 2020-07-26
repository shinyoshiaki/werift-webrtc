import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { createFragments, createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";

export const flight3 = (udp: TransportContext, dtls: DtlsContext) => (
  verifyReq: ServerHelloVerifyRequest
) => {
  const hello = dtls.lastFlight[0] as ClientHello;
  hello.cookie = verifyReq.cookie;
  const fragments = createFragments(dtls)([hello]);
  dtls.handshakeCache = [];
  dtls.bufferHandshakeCache(fragments, true, 3);
  const packets = createPlaintext(dtls)(
    fragments.map((fragment) => ({
      type: ContentType.handshake,
      fragment: fragment.serialize(),
    })),
    ++dtls.recordSequenceNumber
  );
  const buf = Buffer.concat(packets.map((v) => v.serialize()));
  udp.send(buf);
};
