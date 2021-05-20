import { decode, types } from "binary-data";

import { CurveTypes, NamedCurveAlgorithms } from "../../../cipher/const";
import { FragmentedHandshake } from "../../../record/message/fragment";
import { Handshake } from "../../../typings/domain";
import { encodeBuffer } from "../../../util/binary";
import { HandshakeType } from "../../const";

export class ServerKeyExchange implements Handshake {
  msgType = HandshakeType.server_key_exchange;
  messageSeq?: number;

  static readonly spec = {
    ellipticCurveType: types.uint8,
    namedCurve: types.uint16be,
    publicKeyLength: types.uint8,
    publicKey: types.buffer((ctx: any) => ctx.current.publicKeyLength),
    hashAlgorithm: types.uint8,
    signatureAlgorithm: types.uint8,
    signatureLength: types.uint16be,
    signature: types.buffer((ctx: any) => ctx.current.signatureLength),
  };

  constructor(
    public ellipticCurveType: CurveTypes,
    public namedCurve: NamedCurveAlgorithms,
    public publicKeyLength: number,
    public publicKey: Buffer,
    public hashAlgorithm: number,
    public signatureAlgorithm: number,
    public signatureLength: number,
    public signature: Buffer
  ) {}

  static createEmpty() {
    return new ServerKeyExchange(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, ServerKeyExchange.spec);
    return new ServerKeyExchange(
      //@ts-ignore
      ...Object.values(res)
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
      body
    );
  }
}
