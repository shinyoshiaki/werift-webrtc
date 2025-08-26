import { CipherSuiteList } from "../../cipher/const.js";
import type { CipherContext } from "../../context/cipher.js";
import type { DtlsContext } from "../../context/dtls.js";
import type { TransportContext } from "../../context/transport.js";
import { ClientHello } from "../../handshake/message/client/hello.js";
import { DtlsRandom } from "../../handshake/random.js";
import type { Extension } from "../../typings/domain.js";
import { Flight } from "../flight.js";

export class Flight1 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
  ) {
    super(udp, dtls, 1, 3);
  }

  async exec(extensions: Extension[]) {
    if (this.dtls.flight === 1) throw new Error();
    this.dtls.flight = 1;

    const hello = new ClientHello(
      { major: 255 - 1, minor: 255 - 2 },
      new DtlsRandom(),
      Buffer.from([]),
      Buffer.from([]),
      CipherSuiteList,
      [0], // don't compress
      extensions,
    );
    this.dtls.version = hello.clientVersion;
    this.cipher.localRandom = DtlsRandom.from(hello.random);

    const packets = this.createPacket([hello]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    await this.transmit([buf]);
  }
}
