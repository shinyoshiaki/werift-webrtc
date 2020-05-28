import { HandshakeType } from "../../handshake/const";
import { DtlsContext } from "../../context/dtls";
import { prfPreMasterSecret, prfMasterSecret } from "../../cipher/prf";
import { ClientKeyExchange } from "../../handshake/message/client/keyExchange";
import { ChangeCipherSpec } from "../../handshake/message/changeCipherSpec";
import { Finished } from "../../handshake/message/finished";
import { createFragments, createPlaintext } from "../../record/builder";
import { RecordContext } from "../../context/record";
import { TransportContext } from "../../context/transport";
import { ContentType } from "../../record/const";
import { createCipher } from "../../cipher/create";
import { CipherSuite } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";
import { FragmentedHandshake } from "../../record/message/fragment";
import { DtlsPlaintext } from "../../record/message/plaintext";

export class Flight6 {
  constructor(
    private udp: TransportContext,
    private dtls: DtlsContext,
    private record: RecordContext,
    private cipher: CipherContext
  ) {}

  exec(handshakes: (FragmentedHandshake | DtlsPlaintext)[]) {
    if (this.dtls.flight === 6) return;
    this.dtls.flight = 6;

    const fragments = handshakes.map((handshake) => {
      let fragment: FragmentedHandshake = handshake as FragmentedHandshake;
      if ((handshake as FragmentedHandshake).msg_type) {
      } else {
        const raw = this.cipher.decryptPacket(handshake as DtlsPlaintext);
        fragment = FragmentedHandshake.deSerialize(raw);
      }

      const message = (() => {
        switch (fragment.msg_type) {
          case HandshakeType.client_key_exchange:
            return ClientKeyExchange.deSerialize(fragment.fragment);
          case HandshakeType.finished:
            return Finished.deSerialize(fragment.fragment);
        }
      })();

      handlers[message!.msgType]({ dtls: this.dtls, cipher: this.cipher })(
        message
      );
      return fragment;
    });
    this.dtls.bufferHandshake(
      fragments.map((h) => h.serialize()),
      false,
      5
    );

    this.sendChangeCipherSpec();
    this.sendFinished();
  }

  sendChangeCipherSpec() {
    const changeCipherSpec = ChangeCipherSpec.createEmpty().serialize();
    const packets = createPlaintext(this.dtls)(
      [{ type: ContentType.changeCipherSpec, fragment: changeCipherSpec }],
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
  }

  sendFinished() {
    const cache = Buffer.concat(this.dtls.handshakeCache.map((v) => v.data));

    const localVerifyData = this.cipher.verifyData(cache, false);
    const finish = new Finished(localVerifyData);
    const fragments = createFragments(this.dtls)([finish]);
    this.dtls.epoch = 1;
    const pkt = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    )[0];
    this.record.recordSequenceNumber = 0;

    const buf = this.cipher.encryptPacket(pkt).serialize();
    this.udp.send(buf);
  }
}

const handlers: {
  [key: number]: (contexts: {
    dtls: DtlsContext;
    cipher: CipherContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.client_key_exchange] = ({ cipher }) => (
  message: ClientKeyExchange
) => {
  cipher.remoteKeyPair = {
    curve: cipher.namedCurve,
    publicKey: message.publicKey,
  };
  const preMasterSecret = prfPreMasterSecret(
    cipher.remoteKeyPair.publicKey!,
    cipher.localKeyPair?.privateKey!,
    cipher.localKeyPair?.curve!
  )!;
  cipher.masterSecret = prfMasterSecret(
    preMasterSecret,
    cipher.remoteRandom?.serialize()!,
    cipher.localRandom?.serialize()!
  );

  cipher.cipher = createCipher(CipherSuite.EcdheRsaWithAes128GcmSha256)!;
  cipher.cipher.init(
    cipher.masterSecret!,
    cipher.localRandom!.serialize(),
    cipher.remoteRandom!.serialize()
  );
};

handlers[HandshakeType.finished] = () => (message: Finished) => {
  console.log(message);
};
