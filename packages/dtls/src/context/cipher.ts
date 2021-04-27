import { Certificate, PrivateKey } from "@fidm/x509";
import { Crypto } from "@peculiar/webcrypto";
import * as x509 from "@peculiar/x509";
import { decode, encode, types } from "binary-data";
import { createSign } from "crypto";
import { addYears } from "date-fns";
import debug from "debug";
import { randomBytes } from "tweetnacl";
import {
  CipherSuites,
  HashAlgorithm,
  NamedCurveAlgorithm,
  NamedCurveAlgorithms,
  SignatureAlgorithm,
  SignatureHash,
} from "../cipher/const";
import { NamedCurveKeyPair } from "../cipher/namedCurve";
import { prfVerifyDataClient, prfVerifyDataServer } from "../cipher/prf";
import { SessionType, SessionTypes } from "../cipher/suites/abstract";
import AEADCipher from "../cipher/suites/aead";
import { ProtocolVersion } from "../handshake/binary";
import { DtlsRandom } from "../handshake/random";
import { DtlsPlaintext } from "../record/message/plaintext";

const log = debug("werift/dtls/context/cipher");

const crypto = new Crypto();
x509.cryptoProvider.set(crypto);

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
  signatureHashAlgorithm?: SignatureHash;
  localCert!: Buffer;
  localPrivateKey!: PrivateKey;

  constructor(
    public sessionType: SessionTypes,
    public certPem?: string,
    public keyPem?: string,
    signatureHashAlgorithm?: SignatureHash
  ) {
    if (certPem && keyPem && signatureHashAlgorithm) {
      this.parseX509(certPem, keyPem, signatureHashAlgorithm);
    }
  }

  /**
   *
   * @param signatureHash
   * @param namedCurveAlgorithm necessary when use ecdsa
   * @returns
   */
  static async createSelfSignedCertificateWithKey(
    signatureHash: SignatureHash,
    namedCurveAlgorithm?: NamedCurveAlgorithms
  ) {
    const name = (() => {
      switch (signatureHash.signature) {
        case SignatureAlgorithm.rsa:
          return "RSASSA-PKCS1-v1_5";
        case SignatureAlgorithm.ecdsa:
          return "ECDSA";
      }
    })();
    const hash = (() => {
      switch (signatureHash.hash) {
        case HashAlgorithm.sha256:
          return "SHA-256";
      }
    })();
    const namedCurve = (() => {
      switch (namedCurveAlgorithm) {
        case NamedCurveAlgorithm.secp256r1:
          return "P-256";
        case NamedCurveAlgorithm.x25519:
          // todo fix (X25519 not supported with ECDSA)
          if (name === "ECDSA") return "P-256";
          return "X25519";
        default:
          if (name === "ECDSA") return "P-256";
      }
    })();
    const alg = (() => {
      switch (name) {
        case "ECDSA":
          return { name, hash, namedCurve };
        case "RSASSA-PKCS1-v1_5":
          return {
            name,
            hash,
            publicExponent: new Uint8Array([1, 0, 1]),
            modulusLength: 2048,
          };
      }
    })();

    log("createCertificateWithKey alg", alg);
    const keys = (await crypto.subtle.generateKey(alg, true, [
      "sign",
      "verify",
    ])) as any;

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: Buffer.from(randomBytes(10)).toString("hex"),
      name: "C=AU, ST=Some-State, O=Internet Widgits Pty Ltd",
      notBefore: new Date(),
      notAfter: addYears(Date.now(), 10),
      signingAlgorithm: alg,
      keys,
    });

    const certPem = cert.toString("pem");
    const keyPem = x509.PemConverter.encode(
      await crypto.subtle.exportKey("pkcs8", keys.privateKey as any),
      "private key"
    );

    return { certPem, keyPem, signatureHash };
  }

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
    const key = this.localPrivateKey.toPEM().toString();
    const signed = signature.sign(key);
    return signed;
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

  parseX509(certPem: string, keyPem: string, signatureHash: SignatureHash) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    const sec = PrivateKey.fromPEM(Buffer.from(keyPem));
    this.localCert = cert.raw;
    this.localPrivateKey = sec;
    this.signatureHashAlgorithm = signatureHash;
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
