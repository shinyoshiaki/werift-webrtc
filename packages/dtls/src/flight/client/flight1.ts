import { SupportedCipherSuites } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { DtlsContext } from "../../context/dtls";
import { TransportContext } from "../../context/transport";
import { ClientHello } from "../../handshake/message/client/hello";
import { DtlsRandom } from "../../handshake/random";
import { Extension } from "../../typings/domain";
import { Flight } from "../flight";

export class Flight1 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext
  ) {
    super(udp, dtls, 1, 3);
  }

  async exec(
    extensions: Extension[],
    cipherSuiteList: SupportedCipherSuites[]
  ) {
    if (this.dtls.flight === 1) throw new Error();
    this.dtls.flight = 1;

    const hello = new ClientHello(
      { major: 255 - 1, minor: 255 - 2 },
      new DtlsRandom(),
      Buffer.from([]),
      Buffer.from([]),
      cipherSuiteList,
      [0], // don't compress
      extensions
    );
    this.dtls.version = hello.clientVersion;
    this.cipher.localRandom = DtlsRandom.from(hello.random);

    const packets = this.createPacket([hello]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    await this.transmit([buf]);
  }
}
