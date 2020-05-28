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
import { RecordContext } from "../../context/record";
import { TransportContext } from "../../context/transport";
import { DtlsRandom } from "../../handshake/random";
import { ContentType } from "../../record/const";
import { createCipher } from "../../cipher/create";
import { CipherSuite } from "../../cipher/const";
import { CipherContext } from "../../context/cipher";

export class Flight5 {
  constructor(
    private udp: TransportContext,
    private dtls: DtlsContext,
    private record: RecordContext,
    private cipher: CipherContext
  ) {}

  exec(
    messages: (
      | ServerHello
      | Certificate
      | ServerKeyExchange
      | ServerHelloDone
    )[]
  ) {
    if (this.dtls.flight === 5) return;
    this.dtls.flight = 5;

    messages.forEach((message) => {
      handlers[message.msgType]({ client: this.dtls, cipher: this.cipher })(
        message
      );
    });

    this.sendClientKeyExchange();
    this.sendChangeCipherSpec();
    this.sendFinished();
  }

  sendClientKeyExchange() {
    if (!this.cipher.localKeyPair) throw new Error();

    const clientKeyExchange = new ClientKeyExchange(
      this.cipher.localKeyPair.publicKey
    );
    const fragments = createFragments(this.dtls)([clientKeyExchange]);
    this.dtls.bufferHandshake(
      fragments.map((v) => v.fragment),
      true,
      5
    );
    const packets = createPlaintext(this.dtls)(
      fragments,
      ++this.record.recordSequenceNumber
    );
    const buf = Buffer.concat(packets.map((v) => v.serialize()));
    this.udp.send(buf);
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

    const localVerifyData = this.cipher.verifyData(cache);
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
    client: DtlsContext;
    cipher: CipherContext;
  }) => (message: any) => void;
} = {};

handlers[HandshakeType.server_hello] = ({ cipher }) => (
  message: ServerHello
) => {
  cipher.remoteRandom = DtlsRandom.from(message.random);
  cipher.cipherSuite = message.cipherSuite;
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
