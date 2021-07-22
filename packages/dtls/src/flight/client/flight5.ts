import debug from "debug";

import { SignatureAlgorithm, SignatureScheme } from "../../cipher/const";
import { createCipher } from "../../cipher/create";
import { generateKeyPair } from "../../cipher/namedCurve";
import {
  prfExtendedMasterSecret,
  prfMasterSecret,
  prfPreMasterSecret,
} from "../../cipher/prf";
import { CipherContext } from "../../context/cipher";
import { DtlsContext } from "../../context/dtls";
import { SrtpContext } from "../../context/srtp";
import { TransportContext } from "../../context/transport";
import { HandshakeType } from "../../handshake/const";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication";
import { UseSRTP } from "../../handshake/extensions/useSrtp";
import { Certificate } from "../../handshake/message/certificate";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec";
import { CertificateVerify } from "../../handshake/message/client/certificateVerify";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange";
import { Finished } from "../../handshake/message/finished";
import { ServerCertificateRequest } from "../../handshake/message/server/certificateRequest";
import { ServerHello } from "../../handshake/message/server/hello";
import { ServerHelloDone } from "../../handshake/message/server/helloDone";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange";
import { DtlsRandom } from "../../handshake/random";
import { dumpBuffer } from "../../helper";
import { createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";
import { FragmentedHandshake } from "../../record/message/fragment";
import { Flight } from "../flight";

const log = debug(
  "werift-dtls : packages/dtls/src/flight/client/flight5.ts : log"
);

export class Flight5 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
    private srtp: SrtpContext
  ) {
    super(udp, dtls, 5, 7);
  }

  handleHandshake(handshake: FragmentedHandshake) {
    this.dtls.bufferHandshakeCache([handshake], false, 4);
    const message = (() => {
      switch (handshake.msg_type) {
        case HandshakeType.server_hello_2:
          return ServerHello.deSerialize(handshake.fragment);
        case HandshakeType.certificate_11:
          return Certificate.deSerialize(handshake.fragment);
        case HandshakeType.server_key_exchange_12:
          return ServerKeyExchange.deSerialize(handshake.fragment);
        case HandshakeType.certificate_request_13:
          return ServerCertificateRequest.deSerialize(handshake.fragment);
        case HandshakeType.server_hello_done_14:
          return ServerHelloDone.deSerialize(handshake.fragment);
      }
    })();

    if (message) {
      handlers[message.msgType]({
        dtls: this.dtls,
        cipher: this.cipher,
        srtp: this.srtp,
      })(message);
    }
  }

  async exec() {
    if (this.dtls.flight === 5) {
      log(this.dtls.session, "flight5 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 5;

    const needCertificate = this.dtls.requestedCertificateTypes.length > 0;
    log(this.dtls.session, "send flight5", needCertificate);

    const messages = [
      needCertificate && this.sendCertificate(),
      this.sendClientKeyExchange(),
      needCertificate && this.sendCertificateVerify(),
      this.sendChangeCipherSpec(),
      this.sendFinished(),
    ].filter((v) => v) as Buffer[];

    this.dtls.lastMessage = messages;
    await this.transmit(messages);
  }

  sendCertificate() {
    const certificate = new Certificate([Buffer.from(this.cipher.localCert)]);

    const packets = this.createPacket([certificate]);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendClientKeyExchange() {
    if (!this.cipher.localKeyPair) throw new Error();

    const clientKeyExchange = new ClientKeyExchange(
      this.cipher.localKeyPair.publicKey
    );
    const packets = this.createPacket([clientKeyExchange]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));

    const localKeyPair = this.cipher.localKeyPair!;
    const remoteKeyPair = this.cipher.remoteKeyPair!;

    const preMasterSecret = prfPreMasterSecret(
      remoteKeyPair.publicKey!,
      localKeyPair.privateKey,
      localKeyPair.curve
    );

    log(
      this.dtls.session,
      "extendedMasterSecret",
      this.dtls.options.extendedMasterSecret,
      this.dtls.remoteExtendedMasterSecret
    );

    const handshakes = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.data.serialize())
    );
    this.cipher.masterSecret =
      this.dtls.options.extendedMasterSecret &&
      this.dtls.remoteExtendedMasterSecret
        ? prfExtendedMasterSecret(preMasterSecret, handshakes)
        : prfMasterSecret(
            preMasterSecret,
            this.cipher.localRandom!.serialize(),
            this.cipher.remoteRandom!.serialize()
          );

    this.cipher.cipher = createCipher(this.cipher.cipherSuite!);
    this.cipher.cipher.init(
      this.cipher.masterSecret,
      this.cipher.remoteRandom!.serialize(),
      this.cipher.localRandom!.serialize()
    );
    log(this.dtls.session, "cipher", this.cipher.cipher.summary);

    return buf;
  }

  sendCertificateVerify() {
    const cache = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.data.serialize())
    );
    const signed = this.cipher.signatureData(cache, "sha256");
    const signatureScheme = (() => {
      switch (this.cipher.signatureHashAlgorithm?.signature) {
        case SignatureAlgorithm.ecdsa:
          return SignatureScheme.ecdsa_secp256r1_sha256;
        case SignatureAlgorithm.rsa:
          return SignatureScheme.rsa_pkcs1_sha256;
      }
    })();
    if (!signatureScheme) throw new Error();
    log(
      this.dtls.session,
      "signatureScheme",
      this.cipher.signatureHashAlgorithm?.signature,
      signatureScheme
    );

    const certificateVerify = new CertificateVerify(signatureScheme, signed);
    const packets = this.createPacket([certificateVerify]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendChangeCipherSpec() {
    const changeCipherSpec = ChangeCipherSpec.createEmpty().serialize();
    const packets = createPlaintext(this.dtls)(
      [{ type: ContentType.changeCipherSpec, fragment: changeCipherSpec }],
      ++this.dtls.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  sendFinished() {
    const cache = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.data.serialize())
    );
    const localVerifyData = this.cipher.verifyData(cache);

    const finish = new Finished(localVerifyData);
    this.dtls.epoch = 1;
    const [packet] = this.createPacket([finish]);
    log(
      this.dtls.session,
      "raw finish packet",
      packet.summary,
      this.dtls.sortedHandshakeCache.map((h) => h.data.summary)
    );

    this.dtls.recordSequenceNumber = 0;

    const buf = this.cipher.encryptPacket(packet).serialize();
    log(
      this.dtls.session,
      "finished",
      dumpBuffer(buf),
      this.cipher.cipher.summary
    );
    return buf;
  }
}

const handlers: {
  [key: number]: (contexts: {
    dtls: DtlsContext;
    cipher: CipherContext;
    srtp: SrtpContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.server_hello_2] =
  ({ cipher, srtp, dtls }) =>
  (message: ServerHello) => {
    log(dtls.session, "serverHello", message.cipherSuite);
    cipher.remoteRandom = DtlsRandom.from(message.random);
    cipher.cipherSuite = message.cipherSuite;
    log(dtls.session, "selected cipherSuite", cipher.cipherSuite);

    if (message.extensions) {
      message.extensions.forEach((extension) => {
        switch (extension.type) {
          case UseSRTP.type:
            const useSrtp = UseSRTP.fromData(extension.data);
            const profile = SrtpContext.findMatchingSRTPProfile(
              useSrtp.profiles,
              dtls.options.srtpProfiles || []
            );
            log(dtls.session, "selected srtp profile", profile);
            if (profile == undefined) return;
            srtp.srtpProfile = profile;
            break;
          case ExtendedMasterSecret.type:
            dtls.remoteExtendedMasterSecret = true;
            break;
          case RenegotiationIndication.type:
            log(dtls.session, "RenegotiationIndication");
            break;
        }
      });
    }
  };

handlers[HandshakeType.certificate_11] =
  ({ cipher, dtls }) =>
  (message: Certificate) => {
    log(dtls.session, "handshake certificate", message);
    cipher.remoteCertificate = message.certificateList[0];
  };

handlers[HandshakeType.server_key_exchange_12] =
  ({ cipher, dtls }) =>
  (message: ServerKeyExchange) => {
    if (!cipher.localRandom || !cipher.remoteRandom) throw new Error();
    log(dtls.session, "ServerKeyExchange", message);

    log(dtls.session, "selected curve", message.namedCurve);
    cipher.remoteKeyPair = {
      curve: message.namedCurve,
      publicKey: message.publicKey,
    };
    cipher.localKeyPair = generateKeyPair(message.namedCurve);
  };

handlers[HandshakeType.certificate_request_13] =
  ({ dtls }) =>
  (message: ServerCertificateRequest) => {
    log(dtls.session, "certificate_request", message);
    dtls.requestedCertificateTypes = message.certificateTypes;
    dtls.requestedSignatureAlgorithms = message.signatures;
  };

handlers[HandshakeType.server_hello_done_14] =
  ({ dtls }) =>
  (msg) => {
    log(dtls.session, "server_hello_done", msg);
  };
