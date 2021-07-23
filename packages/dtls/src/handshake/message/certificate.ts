import { decode, encode, types } from "binary-data";

import { FragmentedHandshake } from "../../record/message/fragment";
import { Handshake } from "../../typings/domain";
import { ASN11Cert } from "../binary";
import { HandshakeType } from "../const";

// 7.4.2.  Server Certificate
// 7.4.6.  Client Certificate

export class Certificate implements Handshake {
  msgType = HandshakeType.certificate_11;
  messageSeq?: number;
  static readonly spec = {
    certificateList: types.array(ASN11Cert, types.uint24be, "bytes"),
  };

  constructor(public certificateList: Buffer[]) {}

  static createEmpty() {
    return new Certificate(undefined as any);
  }

  static deSerialize(buf: Buffer) {
    return new Certificate(
      //@ts-ignore
      ...Object.values(decode(buf, Certificate.spec))
    );
  }

  serialize() {
    const res = encode(this, Certificate.spec).slice();
    return Buffer.from(res);
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
