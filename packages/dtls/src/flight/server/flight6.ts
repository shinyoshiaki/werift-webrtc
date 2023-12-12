import debug from "debug";

import { createCipher } from "../../cipher/create";
import {
  prfExtendedMasterSecret,
  prfMasterSecret,
  prfPreMasterSecret,
} from "../../cipher/prf";
import { CipherContext } from "../../context/cipher";
import { DtlsContext } from "../../context/dtls";
import { TransportContext } from "../../context/transport";
import { HandshakeType } from "../../handshake/const";
import { Certificate } from "../../handshake/message/certificate";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec";
import { CertificateVerify } from "../../handshake/message/client/certificateVerify";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange";
import { Finished } from "../../handshake/message/finished";
import { createPlaintext } from "../../record/builder";
import { ContentType } from "../../record/const";
import { FragmentedHandshake } from "../../record/message/fragment";
import { Flight } from "../flight";

const log = debug("werift-dtls : packages/dtls/flight/server/flight6.ts");

export class Flight6 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext,
  ) {
    super(udp, dtls, 6);
  }

  handleHandshake(handshake: FragmentedHandshake) {
    this.dtls.bufferHandshakeCache([handshake], false, 5);

    const message = (() => {
      switch (handshake.msg_type) {
        case HandshakeType.certificate_11:
          return Certificate.deSerialize(handshake.fragment);
        case HandshakeType.certificate_verify_15:
          return CertificateVerify.deSerialize(handshake.fragment);
        case HandshakeType.client_key_exchange_16:
          return ClientKeyExchange.deSerialize(handshake.fragment);
        case HandshakeType.finished_20:
          return Finished.deSerialize(handshake.fragment);
      }
    })();

    if (message) {
      const handler = handlers[message.msgType];
      if (!handler) {
        // todo handle certificate_11
        // todo handle certificate_verify_15
        return;
      }
      handler({ dtls: this.dtls, cipher: this.cipher })(message);
    }
  }

  async exec() {
    if (this.dtls.flight === 6) {
      log(this.dtls.sessionId, "flight6 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 6;

    const messages = [this.sendChangeCipherSpec(), this.sendFinished()];
    this.dtls.lastMessage = messages;
    await this.transmit(messages);
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
    this.dtls.recordSequenceNumber = 0;

    const buf = this.cipher.encryptPacket(packet).serialize();
    return buf;
  }
}

const handlers: {
  [key: number]: (contexts: {
    dtls: DtlsContext;
    cipher: CipherContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.client_key_exchange_16] =
  ({ cipher, dtls }) =>
  (message: ClientKeyExchange) => {
    cipher.remoteKeyPair = {
      curve: cipher.namedCurve,
      publicKey: message.publicKey,
    };
    if (
      !cipher.remoteKeyPair.publicKey ||
      !cipher.localKeyPair ||
      !cipher.remoteRandom ||
      !cipher.localRandom
    )
      throw new Error("not exist");

    const preMasterSecret = prfPreMasterSecret(
      cipher.remoteKeyPair.publicKey,
      cipher.localKeyPair.privateKey,
      cipher.localKeyPair.curve,
    );

    log(
      dtls.sessionId,
      "extendedMasterSecret",
      dtls.options.extendedMasterSecret,
      dtls.remoteExtendedMasterSecret,
    );

    const handshakes = Buffer.concat(
      dtls.sortedHandshakeCache.map((v) => v.serialize()),
    );
    cipher.masterSecret =
      dtls.options.extendedMasterSecret && dtls.remoteExtendedMasterSecret
        ? prfExtendedMasterSecret(preMasterSecret, handshakes)
        : prfMasterSecret(
            preMasterSecret,
            cipher.remoteRandom.serialize(),
            cipher.localRandom.serialize(),
          );

    cipher.cipher = createCipher(cipher.cipherSuite!);
    cipher.cipher.init(
      cipher.masterSecret,
      cipher.localRandom.serialize(),
      cipher.remoteRandom.serialize(),
    );
    log(dtls.sessionId, "setup cipher", cipher.cipher.summary);
  };

handlers[HandshakeType.finished_20] =
  ({ dtls }) =>
  (message: Finished) => {
    log(dtls.sessionId, "finished", message);
  };
