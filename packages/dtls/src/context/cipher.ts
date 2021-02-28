import { Certificate, PrivateKey, RSAPrivateKey } from "@fidm/x509";
import { decode, encode, types } from "binary-data";
import { createSign } from "crypto";
import {
  CipherSuites,
  HashAlgorithms,
  NamedCurveAlgorithms,
  SignatureAlgorithms,
} from "../cipher/const";
import { NamedCurveKeyPair } from "../cipher/namedCurve";
import { prfVerifyDataClient, prfVerifyDataServer } from "../cipher/prf";
import { SessionType, SessionTypes } from "../cipher/suites/abstract";
import AEADCipher from "../cipher/suites/aead";
import { ProtocolVersion } from "../handshake/binary";
import { DtlsRandom } from "../handshake/random";
import { DtlsPlaintext } from "../record/message/plaintext";

export class CipherContext {
  localRandom!: DtlsRandom;
  remoteRandom!: DtlsRandom;
  cipherSuite!: CipherSuites;
  remoteCertificate?: Buffer;
  remoteKeyPair!: Partial<NamedCurveKeyPair>;
  localKeyPair!: NamedCurveKeyPair;
  masterSecret!: Buffer;
  cipher!: AEADCipher;
  namedCurve!: NamedCurveAlgorithms;
  signatureHashAlgorithm!: {
    hash: HashAlgorithms;
    signature: SignatureAlgorithms;
  };
  localPrivateKey!: PrivateKey;
  sign = this.parseX509(this.certPem, this.keyPem);

  constructor(
    public certPem: string,
    public keyPem: string,
    public sessionType: SessionTypes
  ) {}

  encryptPacket(pkt: DtlsPlaintext) {
    const header = pkt.recordLayerHeader;
    const enc = this.cipher.encrypt(this.sessionType, pkt.fragment, {
      type: header.contentType,
      version: decode(
        Buffer.from(encode(header.protocolVersion, ProtocolVersion).slice()),
        { version: types.uint16be }
      ).version,
      epoch: header.epoch,
      sequenceNumber: header.sequenceNumber,
    });
    pkt.fragment = enc;
    pkt.recordLayerHeader.contentLen = enc.length;
    return pkt;
  }

  decryptPacket(pkt: DtlsPlaintext) {
    const header = pkt.recordLayerHeader;
    const dec = this.cipher.decrypt(this.sessionType, pkt.fragment, {
      type: header.contentType,
      version: decode(
        Buffer.from(encode(header.protocolVersion, ProtocolVersion).slice()),
        { version: types.uint16be }
      ).version,
      epoch: header.epoch,
      sequenceNumber: header.sequenceNumber,
    });
    return dec;
  }

  verifyData(buf: Buffer) {
    if (this.sessionType === SessionType.CLIENT)
      return prfVerifyDataClient(this.masterSecret, buf);
    else return prfVerifyDataServer(this.masterSecret, buf);
  }

  signatureData(data: Buffer, hash: string) {
    const signature = createSign(hash).update(data);
    const privKey = RSAPrivateKey.fromPrivateKey(this.localPrivateKey);
    const key = privKey.toPEM().toString();
    const signed = signature.sign(key);
    return signed;
  }

  private parseX509(certPem: string, keyPem: string) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    const sec = PrivateKey.fromPEM(Buffer.from(keyPem));
    return { key: sec, cert: cert.raw };
  }

  generateKeySignature(hashAlgorithm: string) {
    const clientRandom =
      this.sessionType === SessionType.CLIENT
        ? this.localRandom
        : this.remoteRandom;
    const serverRandom =
      this.sessionType === SessionType.SERVER
        ? this.localRandom
        : this.remoteRandom;

    const sig = this.valueKeySignature(
      clientRandom.serialize(),
      serverRandom.serialize(),
      this.localKeyPair.publicKey,
      this.namedCurve
    );

    const enc = this.localPrivateKey.sign(sig, hashAlgorithm);
    return enc;
  }

  private valueKeySignature(
    clientRandom: Buffer,
    serverRandom: Buffer,
    publicKey: Buffer,
    namedCurve: number
  ) {
    const serverParams = Buffer.from(
      encode(
        { type: 3, curve: namedCurve, len: publicKey.length },
        { type: types.uint8, curve: types.uint16be, len: types.uint8 }
      ).slice()
    );
    return Buffer.concat([clientRandom, serverRandom, serverParams, publicKey]);
  }
}
