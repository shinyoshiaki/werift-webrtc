import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsContext } from "../../context/dtls";
import { RecordContext } from "../../context/record";
import { CipherContext } from "../../context/cipher";
import { ServerHello } from "../../handshake/message/server/hello";
import { Certificate } from "../../handshake/message/certificate";
import { generateKeySignature, parseX509 } from "../../cipher/x509";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange";
import { ServerHelloDone } from "../../handshake/message/server/helloDone";
import { SignatureAlgorithm, HashAlgorithm } from "../../cipher/const";

export class Flight4 {
  constructor(
    private udp: TransportContext,
    private dtls: DtlsContext,
    private record: RecordContext,
    private cipher: CipherContext
  ) {}

  exec() {
    if (this.dtls.flight === 4) return;
    this.dtls.flight = 4;
    this.dtls.sequenceNumber = 1;

    const messages = [
      this.sendServerHello(),
      this.sendCertificate(),
      this.sendServerKeyExchange(),
      this.sendServerHelloDone(),
    ];
    messages.forEach((buf) => this.udp.send(buf));
  }

  sendServerHello() {
    if (!this.cipher.localRandom || !this.cipher.cipherSuite)
      throw new Error("");

    const serverHello = new ServerHello(
      this.dtls.version,
      this.cipher.localRandom,
      Buffer.from([0x00]),
      this.cipher.cipherSuite,
      0, // compression
      [] // extensions
    );
    const fragments = createFragments(this.dtls)([serverHello]);
    this.dtls.bufferHandshake(
      fragments.map((v) => v.fragment),
      true,
      4
    );
    const packets = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendCertificate() {
    if (!this.cipher.certPem || !this.cipher.keyPem) throw new Error();

    const sign = parseX509(this.cipher.certPem, this.cipher.keyPem);
    this.cipher.localPrivateKey = sign.key;
    const certificate = new Certificate([Buffer.from(sign.cert)]);
    const fragments = createFragments(this.dtls)([certificate]);
    this.dtls.bufferHandshake(
      fragments.map((v) => v.fragment),
      true,
      4
    );
    const packets = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendServerKeyExchange() {
    if (
      !this.cipher.localRandom ||
      !this.cipher.remoteRandom ||
      !this.cipher.localKeyPair ||
      !this.cipher.namedCurve ||
      !this.cipher.localPrivateKey
    )
      throw new Error("");

    const serverRandom = this.cipher.localRandom.serialize();
    const clientRandom = this.cipher.remoteRandom.serialize();
    const signature = generateKeySignature(
      clientRandom,
      serverRandom,
      this.cipher.localKeyPair.publicKey,
      this.cipher.namedCurve,
      this.cipher.localPrivateKey,
      "sha256"
    );
    const keyExchange = new ServerKeyExchange(
      3, // ec curve type
      this.cipher.namedCurve,
      this.cipher.localKeyPair.publicKey.length,
      this.cipher.localKeyPair.publicKey,
      HashAlgorithm.sha256, // hash algorithm
      SignatureAlgorithm.rsa, // signature algorithm
      signature.length,
      signature
    );
    const fragments = createFragments(this.dtls)([keyExchange]);
    this.dtls.bufferHandshake(
      fragments.map((v) => v.fragment),
      true,
      4
    );
    const packets = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendServerHelloDone() {
    const handshake = new ServerHelloDone();
    const fragments = createFragments(this.dtls)([handshake]);
    this.dtls.bufferHandshake(
      fragments.map((v) => v.fragment),
      true,
      4
    );
    const packets = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }
}
