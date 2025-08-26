import { SignatureAlgorithm, SignatureScheme } from "../../cipher/const.js";
import { createCipher } from "../../cipher/create.js";
import { generateKeyPair } from "../../cipher/namedCurve.js";
import {
  prfExtendedMasterSecret,
  prfMasterSecret,
  prfPreMasterSecret,
} from "../../cipher/prf.js";
import type { CipherContext } from "../../context/cipher.js";
import type { DtlsContext } from "../../context/dtls.js";
import { SrtpContext } from "../../context/srtp.js";
import type { TransportContext } from "../../context/transport.js";
import { HandshakeType } from "../../handshake/const.js";
import { ExtendedMasterSecret } from "../../handshake/extensions/extendedMasterSecret.js";
import { RenegotiationIndication } from "../../handshake/extensions/renegotiationIndication.js";
import { UseSRTP } from "../../handshake/extensions/useSrtp.js";
import { Certificate } from "../../handshake/message/certificate.js";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec.js";
import { CertificateVerify } from "../../handshake/message/client/certificateVerify.js";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange.js";
import { Finished } from "../../handshake/message/finished.js";
import { ServerCertificateRequest } from "../../handshake/message/server/certificateRequest.js";
import { ServerHello } from "../../handshake/message/server/hello.js";
import { ServerHelloDone } from "../../handshake/message/server/helloDone.js";
import { ServerKeyExchange } from "../../handshake/message/server/keyExchange.js";
import { DtlsRandom } from "../../handshake/random.js";
import { type SrtpProfile, debug } from "../../imports/rtp.js";
import { createPlaintext } from "../../record/builder.js";
import { ContentType } from "../../record/const.js";
import type { FragmentedHandshake } from "../../record/message/fragment.js";
import { Flight } from "../flight.js";

const log = debug(
  "werift-dtls : packages/dtls/src/flight/client/flight5.ts : log",
);

export class Flight5 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
    private srtp: SrtpContext,
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
      log(this.dtls.sessionId, "flight5 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 5;

    const needCertificate = this.dtls.requestedCertificateTypes.length > 0;
    log(this.dtls.sessionId, "send flight5", needCertificate);

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

  private sendCertificate() {
    const certificate = new Certificate([Buffer.from(this.cipher.localCert)]);

    const packets = this.createPacket([certificate]);

    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  private sendClientKeyExchange() {
    if (!this.cipher.localKeyPair) throw new Error();

    const clientKeyExchange = new ClientKeyExchange(
      this.cipher.localKeyPair.publicKey,
    );
    const packets = this.createPacket([clientKeyExchange]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));

    const localKeyPair = this.cipher.localKeyPair;
    const remoteKeyPair = this.cipher.remoteKeyPair;

    if (!remoteKeyPair.publicKey) throw new Error("not exist");

    const preMasterSecret = prfPreMasterSecret(
      remoteKeyPair.publicKey,
      localKeyPair.privateKey,
      localKeyPair.curve,
    );

    log(
      this.dtls.sessionId,
      "extendedMasterSecret",
      this.dtls.options.extendedMasterSecret,
      this.dtls.remoteExtendedMasterSecret,
    );

    const handshakes = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.serialize()),
    );
    this.cipher.masterSecret =
      this.dtls.options.extendedMasterSecret &&
      this.dtls.remoteExtendedMasterSecret
        ? prfExtendedMasterSecret(preMasterSecret, handshakes)
        : prfMasterSecret(
            preMasterSecret,
            this.cipher.localRandom.serialize(),
            this.cipher.remoteRandom.serialize(),
          );

    this.cipher.cipher = createCipher(this.cipher.cipherSuite);
    this.cipher.cipher.init(
      this.cipher.masterSecret,
      this.cipher.remoteRandom.serialize(),
      this.cipher.localRandom.serialize(),
    );
    log(this.dtls.sessionId, "cipher", this.cipher.cipher.summary);

    return buf;
  }

  private sendCertificateVerify() {
    const cache = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.serialize()),
    );
    const signed = this.cipher.signatureData(cache, "sha256");
    const signatureScheme = (() => {
      switch (this.cipher.signatureHashAlgorithm?.signature) {
        case SignatureAlgorithm.ecdsa_3:
          return SignatureScheme.ecdsa_secp256r1_sha256;
        case SignatureAlgorithm.rsa_1:
          return SignatureScheme.rsa_pkcs1_sha256;
      }
    })();
    if (!signatureScheme) throw new Error();
    log(
      this.dtls.sessionId,
      "signatureScheme",
      this.cipher.signatureHashAlgorithm?.signature,
      signatureScheme,
    );

    const certificateVerify = new CertificateVerify(signatureScheme, signed);
    const packets = this.createPacket([certificateVerify]);
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  private sendChangeCipherSpec() {
    const changeCipherSpec = ChangeCipherSpec.createEmpty().serialize();
    const packets = createPlaintext(this.dtls)(
      [{ type: ContentType.changeCipherSpec, fragment: changeCipherSpec }],
      ++this.dtls.recordSequenceNumber,
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    return buf;
  }

  private sendFinished() {
    const cache = Buffer.concat(
      this.dtls.sortedHandshakeCache.map((v) => v.serialize()),
    );
    const localVerifyData = this.cipher.verifyData(cache);

    const finish = new Finished(localVerifyData);
    this.dtls.epoch = 1;
    const [packet] = this.createPacket([finish]);
    // log(
    //   this.dtls.sessionId,
    //   "raw finish packet",
    //   packet.summary,
    //   this.dtls.sortedHandshakeCache.map((h) => h.summary),
    // );

    this.dtls.recordSequenceNumber = 0;

    const buf = this.cipher.encryptPacket(packet).serialize();
    log(this.dtls.sessionId, "finished", this.cipher.cipher.summary);
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
    log(dtls.sessionId, "serverHello", message.cipherSuite);
    cipher.remoteRandom = DtlsRandom.from(message.random);
    cipher.cipherSuite = message.cipherSuite;
    log(dtls.sessionId, "selected cipherSuite", cipher.cipherSuite);

    if (message.extensions) {
      message.extensions.forEach((extension) => {
        switch (extension.type) {
          case UseSRTP.type:
            {
              const useSrtp = UseSRTP.fromData(extension.data);
              const profile = SrtpContext.findMatchingSRTPProfile(
                useSrtp.profiles as SrtpProfile[],
                dtls.options.srtpProfiles || [],
              );
              log(dtls.sessionId, "selected srtp profile", profile);
              if (profile == undefined) return;
              srtp.srtpProfile = profile;
            }
            break;
          case ExtendedMasterSecret.type:
            dtls.remoteExtendedMasterSecret = true;
            break;
          case RenegotiationIndication.type:
            log(dtls.sessionId, "RenegotiationIndication");
            break;
        }
      });
    }
  };

handlers[HandshakeType.certificate_11] =
  ({ cipher, dtls }) =>
  (message: Certificate) => {
    log(dtls.sessionId, "handshake certificate", message);
    cipher.remoteCertificate = message.certificateList[0];
  };

handlers[HandshakeType.server_key_exchange_12] =
  ({ cipher, dtls }) =>
  (message: ServerKeyExchange) => {
    if (!cipher.localRandom || !cipher.remoteRandom) throw new Error();
    log(dtls.sessionId, "ServerKeyExchange", message);

    log(dtls.sessionId, "selected curve", message.namedCurve);
    cipher.remoteKeyPair = {
      curve: message.namedCurve,
      publicKey: message.publicKey,
    };
    cipher.localKeyPair = generateKeyPair(message.namedCurve);
  };

handlers[HandshakeType.certificate_request_13] =
  ({ dtls }) =>
  (message: ServerCertificateRequest) => {
    log(dtls.sessionId, "certificate_request", message);
    dtls.requestedCertificateTypes = message.certificateTypes;
    dtls.requestedSignatureAlgorithms = message.signatures;
  };

handlers[HandshakeType.server_hello_done_14] =
  ({ dtls }) =>
  (msg) => {
    log(dtls.sessionId, "server_hello_done", msg);
  };
