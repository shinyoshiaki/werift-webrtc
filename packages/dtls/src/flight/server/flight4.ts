import debug from "debug";

import {
  CurveType,
  HashAlgorithm,
  SignatureAlgorithm,
} from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { DtlsContext } from "../../context/dtls";
import { SrtpContext } from "../../context/srtp";
import { TransportContext } from "../../context/transport";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { Certificate } from "../../handshake/message/certificate";
import { ServerCertificateRequest } from "../../handshake/message/server/certificateRequest";
import { ServerHello } from "../../handshake/message/server/hello";
import { ServerHelloDone } from "../../handshake/message/server/helloDone";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange";
import { FragmentedHandshake } from "../../record/message/fragment";
import { Extension } from "../../typings/domain";
import { Flight } from "../flight";

const log = debug("werift/dtls/flight4");

export class Flight4 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
    private srtp: SrtpContext
  ) {
    super(udp, dtls, 4, 6);
  }

  async exec(
    assemble: FragmentedHandshake,
    certificateRequest: boolean = false
  ) {
    if (this.dtls.flight === 4) {
      log("flight4 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 4;
    this.dtls.sequenceNumber = 1;
    this.dtls.bufferHandshakeCache([assemble], false, 4);

    const messages = [
      this.sendServerHello(),
      this.sendCertificate(),
      this.sendServerKeyExchange(),
      certificateRequest && this.sendCertificateRequest(),
      this.sendServerHelloDone(),
    ].filter((v) => v) as Buffer[];

    this.dtls.lastMessage = messages;
    await this.transmit(messages);
  }

  private sendServerHello() {
    // todo fix; should use socket.extensions
    const extensions: Extension[] = [];
    if (this.srtp.srtpProfile) {
      extensions.push(
        UseSRTP.create([this.srtp.srtpProfile], Buffer.from([0x00])).extension
      );
    }
    if (this.dtls.options.extendedMasterSecret) {
      extensions.push({
        type: ExtendedMasterSecret.type,
        data: Buffer.alloc(0),
      });
    }
    const renegotiationIndication = RenegotiationIndication.createEmpty();
    extensions.push(renegotiationIndication.extension);

    const serverHello = new ServerHello(
      this.dtls.version,
      this.cipher.localRandom,
      Buffer.from([0x00]),
      this.cipher.cipherSuite,
      0, // do not compression
      extensions
    );
    const packets = this.createPacket([serverHello]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  // 7.4.2 Server Certificate
  private sendCertificate() {
    const certificate = new Certificate([Buffer.from(this.cipher.localCert)]);

    const packets = this.createPacket([certificate]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  private sendServerKeyExchange() {
    const signature = this.cipher.generateKeySignature("sha256");
    const keyExchange = new ServerKeyExchange(
      CurveType.named_curve,
      this.cipher.namedCurve,
      this.cipher.localKeyPair.publicKey.length,
      this.cipher.localKeyPair.publicKey,
      this.cipher.signatureHashAlgorithm!.hash,
      this.cipher.signatureHashAlgorithm!.signature,
      signature.length,
      signature
    );

    const packets = this.createPacket([keyExchange]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  // 7.4.4.  Certificate Request
  private sendCertificateRequest() {
    const handshake = new ServerCertificateRequest(
      [
        1, // clientCertificateTypeRSASign
        64, // clientCertificateTypeECDSASign
      ],
      [
        { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.rsa },
        { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.ecdsa },
      ],
      []
    );
    log("sendCertificateRequest", handshake);
    const packets = this.createPacket([handshake]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }

  private sendServerHelloDone() {
    const handshake = new ServerHelloDone();

    const packets = this.createPacket([handshake]);
    return Buffer.concat(packets.map((v) => v.serialize()));
  }
}
