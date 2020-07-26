import { ServerHello } from "../../handshake/message/server/hello";
import { Certificate } from "../../handshake/message/certificate";
import { ServerHelloDone } from "../../handshake/message/server/helloDone";
import { HandshakeType } from "../../handshake/const";
import { DtlsContext } from "../../context/dtls";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange";
import { generateKeyPair } from "../../cipher/namedCurve";
import { prfPreMasterSecret, prfMasterSecret } from "../../cipher/prf";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec";
import { Finished } from "../../handshake/message/finished";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { DtlsRandom } from "../../handshake/random";
import { ContentType } from "../../record/const";
import { createCipher } from "../../cipher/create";
import { CipherSuite } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { ServerCertificateRequest } from "../../handshake/message/server/certificateRequest";
import { parseX509 } from "../../cipher/x509";
import { CertificateVerify } from "../../handshake/message/client/certificateVerify";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { SrtpContext } from "../../context/srtp";

export class Flight5 {
  constructor(
    private udp: TransportContext,
    private dtls: DtlsContext,
    private cipher: CipherContext,
    private srtp: SrtpContext
  ) {}

  exec(
    messages: (
      | ServerHello
      | Certificate
      | ServerKeyExchange
      | ServerHelloDone
      | ServerCertificateRequest
    )[]
  ) {
    if (this.dtls.flight === 5) return;
    this.dtls.flight = 5;

    messages.forEach((message) => {
      handlers[message.msgType]({
        dtls: this.dtls,
        cipher: this.cipher,
        srtp: this.srtp,
      })(message);
    });

    if (this.dtls.requestedCertificateTypes.length > 0) this.sendCertificate();
    this.sendClientKeyExchange();
    if (this.dtls.requestedCertificateTypes.length > 0)
      this.sendCertificateVerify();
    this.sendChangeCipherSpec();
    this.sendFinished();
  }

  sendCertificate() {
    if (!this.cipher.certPem || !this.cipher.keyPem) throw new Error();

    const sign = parseX509(this.cipher.certPem, this.cipher.keyPem);
    this.cipher.localPrivateKey = sign.key;
    const certificate = new Certificate([Buffer.from(sign.cert)]);
    const fragments = createFragments(this.dtls)([certificate]);
    this.dtls.bufferHandshakeCache(fragments, true, 5);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
  }

  sendClientKeyExchange() {
    if (!this.cipher.localKeyPair) throw new Error();

    const clientKeyExchange = new ClientKeyExchange(
      this.cipher.localKeyPair.publicKey
    );
    const fragments = createFragments(this.dtls)([clientKeyExchange]);
    this.dtls.bufferHandshakeCache(fragments, true, 5);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
  }

  sendCertificateVerify() {
    const caches = this.dtls.handshakeCache.map((v) => v.data);
    const cache = Buffer.concat(caches.map((v) => v.serialize()));
    const signed = this.cipher.signatureData(cache, "sha256");
    const certificateVerify = new CertificateVerify(0x0401, signed);
    const fragments = createFragments(this.dtls)([certificateVerify]);
    this.dtls.bufferHandshakeCache(fragments, true, 5);
    const packets = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
  }

  sendChangeCipherSpec() {
    const changeCipherSpec = ChangeCipherSpec.createEmpty().serialize();
    const packets = createPlaintext(this.dtls)(
      [{ type: ContentType.changeCipherSpec, fragment: changeCipherSpec }],
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
  }

  sendFinished() {
    const cache = Buffer.concat(
      this.dtls.handshakeCache.map((v) => v.data.serialize())
    );

    const localVerifyData = this.cipher.verifyData(cache);
    const finish = new Finished(localVerifyData);
    const fragments = createFragments(this.dtls)([finish]);
    this.dtls.epoch = 1;
    const pkt = createPlaintext(this.dtls)(
      fragments.map((fragment) => ({
        type: ContentType.handshake,
        fragment: fragment.serialize(),
      })),
      ++this.dtls.recordSequenceNumber
    )[0];
    this.dtls.recordSequenceNumber = 0;

    const buf = this.cipher.encryptPacket(pkt).serialize();
    this.udp.send(buf);
  }
}

const handlers: {
  [key: number]: (contexts: {
    dtls: DtlsContext;
    cipher: CipherContext;
    srtp: SrtpContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.server_hello] = ({ cipher, srtp, dtls }) => (
  message: ServerHello
) => {
  cipher.remoteRandom = DtlsRandom.from(message.random);
  cipher.cipherSuite = message.cipherSuite;
  if (message.extensions) {
    message.extensions.forEach((extension) => {
      switch (extension.type) {
        case UseSRTP.type:
          const useSrtp = UseSRTP.fromData(extension.data);
          const profile = SrtpContext.findMatchingSRTPProfile(
            useSrtp.profiles,
            dtls.options.srtpProfiles!
          );
          if (profile === undefined) return;
          srtp.srtpProfile = profile;
          break;
      }
    });
  }
};

handlers[HandshakeType.certificate] = ({ cipher }) => (
  message: Certificate
) => {
  cipher.remoteCertificate = message.certificateList[0];
};

handlers[HandshakeType.server_key_exchange] = ({ cipher }) => (
  message: ServerKeyExchange
) => {
  cipher.remoteKeyPair = {
    curve: message.namedCurve,
    publicKey: message.publicKey,
  };
  cipher.localKeyPair = generateKeyPair(message.namedCurve);
  const preMasterSecret = prfPreMasterSecret(
    cipher.remoteKeyPair.publicKey!,
    cipher.localKeyPair?.privateKey!,
    cipher.localKeyPair?.curve!
  )!;
  cipher.masterSecret = prfMasterSecret(
    preMasterSecret,
    cipher.localRandom?.serialize()!,
    cipher.remoteRandom?.serialize()!
  );

  cipher.cipher = createCipher(CipherSuite.EcdheEcdsaWithAes128GcmSha256)!;
  cipher.cipher.init(
    cipher.masterSecret!,
    cipher.remoteRandom!.serialize(),
    cipher.localRandom!.serialize()
  );
};

handlers[HandshakeType.server_hello_done] = () => () => {};

handlers[HandshakeType.certificate_request] = ({ dtls }) => (
  message: ServerCertificateRequest
) => {
  dtls.requestedCertificateTypes = message.certificateTypes;
  dtls.requestedSignatureAlgorithms = message.signatures;
};
