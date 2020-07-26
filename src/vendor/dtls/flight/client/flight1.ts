import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { CipherSuite } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { ContentType } from "../../record/const";
import { Extension } from "../../typings/domain";

export const flight1 = async (
  udp: TransportContext,
  dtls: DtlsContext,
  cipher: CipherContext,
  extensions: Extension[]
) => {
  const hello = new ClientHello(
    { major: 255 - 1, minor: 255 - 2 },
    new DtlsRandom(),
    Buffer.from([]),
    Buffer.from([]),
    [
      CipherSuite.EcdheRsaWithAes128GcmSha256,
      CipherSuite.EcdheEcdsaWithAes128GcmSha256,
    ],
    [0], // don't compress
    extensions
  );

  const fragments = createFragments(dtls)([hello]);
  dtls.bufferHandshakeCache(fragments, true, 1);
  const packets = createPlaintext(dtls)(
    fragments.map((fragment) => ({
      type: ContentType.handshake,
      fragment: fragment.serialize(),
    })),
    ++dtls.recordSequenceNumber
  );
  const buf = Buffer.concat(packets.map((v) => v.serialize()));
  udp.send(buf);

  dtls.version = hello.clientVersion;
  cipher.localRandom = DtlsRandom.from(hello.random);
};
