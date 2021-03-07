import { HandshakeType } from "../../handshake/const";
import { DtlsContext } from "../../context/dtls";
import {
  prfPreMasterSecret,
  prfMasterSecret,
  prfExtendedMasterSecret,
} from "../../cipher/prf";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec";
import { Finished } from "../../handshake/message/finished";
import { createFragments, createPlaintext } from "../../record/builder";
import { TransportContext } from "../../context/transport";
import { ContentType } from "../../record/const";
import { createCipher } from "../../cipher/create";
import { CipherContext } from "../../context/cipher";
import { FragmentedHandshake } from "../../record/message/fragment";
import { Flight } from "../flight";
import debug from "debug";

const log = debug("werift/dtls/flight6");

export class Flight6 extends Flight {
  constructor(
    udp: TransportContext,
    dtls: DtlsContext,
    private cipher: CipherContext
  ) {
    super(udp, dtls);
  }

  handleHandshake(handshake: FragmentedHandshake) {
    this.dtls.bufferHandshakeCache([handshake], false, 5);

    const message = (() => {
      switch (handshake.msg_type) {
        case HandshakeType.client_key_exchange:
          return ClientKeyExchange.deSerialize(handshake.fragment);
        case HandshakeType.finished:
          return Finished.deSerialize(handshake.fragment);
      }
    })();

    if (message) {
      handlers[message.msgType]({ dtls: this.dtls, cipher: this.cipher })(
        message
      );
    }
  }

  exec() {
    if (this.dtls.flight === 6) {
      log("flight6 twice");
      this.send(this.dtls.lastMessage);
      return;
    }
    this.dtls.flight = 6;

    const messages = [this.sendChangeCipherSpec(), this.sendFinished()];
    this.dtls.lastMessage = messages;
    this.transmit(messages);
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
    return buf;
  }
}

const handlers: {
  [key: number]: (contexts: {
    dtls: DtlsContext;
    cipher: CipherContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.client_key_exchange] = ({ cipher, dtls }) => (
  message: ClientKeyExchange
) => {
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
    throw new Error();

  const preMasterSecret = prfPreMasterSecret(
    cipher.remoteKeyPair.publicKey,
    cipher.localKeyPair.privateKey,
    cipher.localKeyPair.curve
  );

  log(
    "extendedMasterSecret",
    dtls.options.extendedMasterSecret,
    dtls.remoteExtendedMasterSecret
  );

  const handshakes = Buffer.concat(
    dtls.handshakeCache.map((v) => v.data.serialize())
  );
  cipher.masterSecret =
    dtls.options.extendedMasterSecret && dtls.remoteExtendedMasterSecret
      ? prfExtendedMasterSecret(preMasterSecret, handshakes)
      : prfMasterSecret(
          preMasterSecret,
          cipher.remoteRandom.serialize(),
          cipher.localRandom.serialize()
        );

  cipher.cipher = createCipher(cipher.cipherSuite!);
  cipher.cipher.init(
    cipher.masterSecret,
    cipher.localRandom.serialize(),
    cipher.remoteRandom.serialize()
  );
};

handlers[HandshakeType.finished] = () => (message: Finished) => {
  log("finished", message);
};
