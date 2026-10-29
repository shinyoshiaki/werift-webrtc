import {
  createPrivateKey,
  createSign,
  generateKeyPair,
  type KeyObject,
  X509Certificate,
} from "node:crypto";
import { promisify } from "node:util";
import {
  type CipherSuites,
  CurveType,
  HashAlgorithm,
  type NamedCurveAlgorithms,
  SignatureAlgorithm,
  type SignatureHash,
} from "../cipher/const";
import type { NamedCurveKeyPair } from "../cipher/namedCurve";
import { prfVerifyDataClient, prfVerifyDataServer } from "../cipher/prf";
import { SessionType, type SessionTypes } from "../cipher/suites/abstract";
import type AEADCipher from "../cipher/suites/aead";
import type { DtlsRandom } from "../handshake/random";
import { binaryData } from "../imports/common";
import type { DtlsPlaintext } from "../record/message/plaintext";
import { createSelfSignedCertificatePem } from "./certificate";

const { encode, types } = binaryData;

const generateKeyPairAsync = promisify(generateKeyPair);

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
  localPrivateKey!: KeyObject;

  constructor(
    public sessionType: SessionTypes,
    public certPem?: string,
    public keyPem?: string,
    signatureHashAlgorithm?: SignatureHash,
  ) {
    if (certPem && keyPem && signatureHashAlgorithm) {
      this.parseX509(certPem, keyPem, signatureHashAlgorithm);
    }
  }

  /**
   *
   * @param signatureHash
   * @param namedCurveAlgorithm kept for compatibility. ECDSA certificates always use P-256 (X25519 cannot sign).
   */
  static createSelfSignedCertificateWithKey = async (
    signatureHash: SignatureHash,
    namedCurveAlgorithm?: NamedCurveAlgorithms,
  ) => {
    if (signatureHash.hash !== HashAlgorithm.sha256_4) {
      throw new Error(`unsupported hash algorithm: ${signatureHash.hash}`);
    }

    const { publicKey, privateKey } = await (() => {
      switch (signatureHash.signature) {
        case SignatureAlgorithm.rsa_1:
          return generateKeyPairAsync("rsa", {
            modulusLength: 2048,
            publicExponent: 0x10001,
          });
        case SignatureAlgorithm.ecdsa_3:
          return generateKeyPairAsync("ec", { namedCurve: "P-256" });
        default:
          throw new Error(
            `unsupported signature algorithm: ${signatureHash.signature}`,
          );
      }
    })();

    const notBefore = new Date();
    const certPem = createSelfSignedCertificatePem({
      publicKey,
      privateKey,
      signatureAlgorithm:
        signatureHash.signature === SignatureAlgorithm.ecdsa_3
          ? "ecdsa-sha256"
          : "rsa-sha256",
      name: [
        ["C", "AU"],
        ["ST", "Some-State"],
        ["O", "Internet Widgits Pty Ltd"],
      ],
      notBefore,
      notAfter: new Date(notBefore.getTime() + 10 * 365 * 24 * 60 * 60 * 1000),
    });
    const keyPem = privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;

    return { certPem, keyPem, signatureHash };
  };

  encryptPacket(pkt: DtlsPlaintext) {
    const header = pkt.recordLayerHeader;
    const version =
      (header.protocolVersion.major << 8) | header.protocolVersion.minor;
    const enc = this.cipher.encrypt(this.sessionType, pkt.fragment, {
      type: header.contentType,
      version,
      epoch: header.epoch,
      sequenceNumber: header.sequenceNumber,
    });
    pkt.fragment = enc;
    pkt.recordLayerHeader.contentLen = enc.length;
    return pkt;
  }

  decryptPacket(pkt: DtlsPlaintext) {
    const header = pkt.recordLayerHeader;
    const version =
      (header.protocolVersion.major << 8) | header.protocolVersion.minor;
    const dec = this.cipher.decrypt(this.sessionType, pkt.fragment, {
      type: header.contentType,
      version,
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
    return createSign(hash).update(data).sign(this.localPrivateKey);
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
      this.namedCurve,
    );

    return createSign(hashAlgorithm).update(sig).sign(this.localPrivateKey);
  }

  parseX509(certPem: string, keyPem: string, signatureHash: SignatureHash) {
    this.localCert = new X509Certificate(normalizePem(certPem)).raw;
    this.localPrivateKey = createPrivateKey(normalizePem(keyPem));
    this.signatureHashAlgorithm = signatureHash;
  }

  private valueKeySignature(
    clientRandom: Buffer,
    serverRandom: Buffer,
    publicKey: Buffer,
    namedCurve: number,
  ) {
    const serverParams = encode(
      {
        type: CurveType.named_curve_3,
        curve: namedCurve,
        len: publicKey.length,
      },
      { type: types.uint8, curve: types.uint16be, len: types.uint8 },
    );
    return Buffer.concat([clientRandom, serverRandom, serverParams, publicKey]);
  }
}

/**
 * Trims indentation and blank lines from each PEM line.
 * `node:crypto` rejects indented PEM (e.g. written in an indented template literal),
 * which the previous `@fidm/x509` parser accepted.
 */
export function normalizePem(pem: string) {
  return `${pem
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n")}\n`;
}
