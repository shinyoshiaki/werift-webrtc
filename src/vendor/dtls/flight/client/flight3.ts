import { UdpContext } from "../../context/udp";
import { DtlsContext } from "../../context/dtls";
import { ClientHello } from "../../handshake/message/client/hello";
import { ServerHelloVerifyRequest } from "../../handshake/message/server/helloVerifyRequest";
import { createFragments, createPlaintext } from "../../record/builder";
import { RecordContext } from "../../context/record";

export const flight3 = (
  udp: UdpContext,
  client: DtlsContext,
  record: RecordContext
) => (verifyReq: ServerHelloVerifyRequest) => {
  const hello = client.lastFlight[0] as ClientHello;
  hello.cookie = verifyReq.cookie;
  const fragments = createFragments(client)([hello]);
  client.bufferHandshake(
    fragments.map((v) => v.fragment),
    true,
    3
  );
  const packets = createPlaintext(client)(
    fragments,
    ++record.recordSequenceNumber
  );
  const buf = Buffer.concat(packets.map((v) => v.serialize()));
  udp.send(buf);
};
