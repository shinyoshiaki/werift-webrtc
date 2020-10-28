import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { CipherSuite } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { ContentType } from "../../record/const";
import { Extension } from "../../typings/domain";
import { Flight } from "../flight";

export class Flight1 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext
  ) {
    super(udp, dtls, 3);
  }

  exec(extensions: Extension[]) {
    if (this.dtls.flight === 1) throw new Error();
    this.dtls.flight = 1;

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

    const fragments = createFragments(this.dtls)([hello]);
    this.dtls.bufferHandshakeCache(fragments, true, 1);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );

    this.dtls.version = hello.clientVersion;
    this.cipher.localRandom = DtlsRandom.from(hello.random);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.transmit([buf]);
  }
}
