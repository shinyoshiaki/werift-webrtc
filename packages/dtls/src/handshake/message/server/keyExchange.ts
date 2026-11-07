import type { CurveTypes, NamedCurveAlgorithms } from "../../../cipher/const";
import { binaryData } from "../../../imports/common";
import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { encodeBuffer } from "../../../util/binary";
import { HandshakeType } from "../../const";

const { decode, types } = binaryData;

export class ServerKeyExchange implements Handshake {
  public ellipticCurveType: CurveTypes;
  public namedCurve: NamedCurveAlgorithms;
  public publicKeyLength: number;
  public publicKey: Buffer;
  public hashAlgorithm: number;
  public signatureAlgorithm: number;
  public signatureLength: number;
  public signature: Buffer;

  msgType: HandshakeType = HandshakeType.server_key_exchange_12;
  messageSeq?: number;

  static readonly spec = {
    ellipticCurveType: types.uint8,
    namedCurve: types.uint16be,
    publicKeyLength: types.uint8,
    publicKey: types.buffer((ctx) => ctx.current.publicKeyLength),
    hashAlgorithm: types.uint8,
    signatureAlgorithm: types.uint8,
    signatureLength: types.uint16be,
    signature: types.buffer((ctx) => ctx.current.signatureLength),
  };

  constructor(
    ellipticCurveType: CurveTypes,
    namedCurve: NamedCurveAlgorithms,
    publicKeyLength: number,
    publicKey: Buffer,
    hashAlgorithm: number,
    signatureAlgorithm: number,
    signatureLength: number,
    signature: Buffer,
  ) {
    this.ellipticCurveType = ellipticCurveType;
    this.namedCurve = namedCurve;
    this.publicKeyLength = publicKeyLength;
    this.publicKey = publicKey;
    this.hashAlgorithm = hashAlgorithm;
    this.signatureAlgorithm = signatureAlgorithm;
    this.signatureLength = signatureLength;
    this.signature = signature;
  }

  static createEmpty() {
    return new ServerKeyExchange(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, ServerKeyExchange.spec);
    return new ServerKeyExchange(
      //@ts-expect-error
      ...Object.values(res),
    );
  }

  serialize() {
    const res = encodeBuffer(this, ServerKeyExchange.spec);
    return res;
  }

  toFragment() {
    const body = this.serialize();
    return new FragmentedHandshake(
      this.msgType,
      body.length,
      this.messageSeq!,
      0,
      body.length,
      body,
    );
  }
}
