import { PrivateKey, RSAPrivateKey } from "@fidm/x509";
import { decode, encode, types } from "binary-data";
import { createSign } from "crypto";
import { NamedCurveKeyPair } from "../cipher/namedCurve";
import { prfVerifyDataClient, prfVerifyDataServer } from "../cipher/prf";
import { SessionType } from "../cipher/suites/abstract";
import AEADCipher from "../cipher/suites/aead";
import { ProtocolVersion } from "../handshake/binary";
import { DtlsRandom } from "../handshake/random";
import { DtlsPlaintext } from "../record/message/plaintext";

export class CipherContext {
  sessionType?: SessionType;
  localRandom?: DtlsRandom;
  remoteRandom?: DtlsRandom;
  cipherSuite?: number;
  remoteCertificate?: Buffer;
  remoteKeyPair?: Partial<NamedCurveKeyPair>;
  localKeyPair?: NamedCurveKeyPair;
  masterSecret?: Buffer;
  cipher?: AEADCipher;
  namedCurve?: number;
  localPrivateKey?: PrivateKey;
  certPem?: string;
  keyPem?: string;

  encryptPacket(pkt: DtlsPlaintext) {
    const header = pkt.recordLayerHeader;
    const enc = this.cipher?.encrypt(this.sessionType!, pkt.fragment, {
      type: header.contentType,
      version: decode(
        Buffer.from(encode(header.protocolVersion, ProtocolVersion).slice()),
        { version: types.uint16be }
      ).version,
      epoch: header.epoch,
      sequenceNumber: header.sequenceNumber,
    })!;
    pkt.fragment = enc;
    pkt.recordLayerHeader.contentLen = enc.length;
    return pkt;
  }

  decryptPacket(pkt: DtlsPlaintext) {
    if (!this.cipher || !this.sessionType) throw new Error("");

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

  verifyData(buf: Buffer, isClient = true) {
    if (isClient) return prfVerifyDataClient(this.masterSecret!, buf);
    else return prfVerifyDataServer(this.masterSecret!, buf);
  }

  signatureData(data: Buffer, hash: string) {
    const signature = createSign(hash).update(data);
    const privKey = RSAPrivateKey.fromPrivateKey(this.localPrivateKey!);
    const key = privKey.toPEM().toString()!;
    const signed = signature.sign(key);
    return signed;
  }
}
