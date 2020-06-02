import { encode, types, decode } from "binary-data";
import { HandshakeType } from "../../const";
import { Handshake } from "../../../typings/domain";
import { FragmentedHandshake } from "../../../record/message/fragment";

export class CertificateVerify implements Handshake {
  msgType = HandshakeType.certificate_verify;
  messageSeq?: number;

  static readonly spec = {
    algorithm: types.uint16be,
    signature: types.buffer(types.uint16be),
  };

  constructor(public algorithm: number, public signature: Buffer) {}

  static createEmpty() {
    return new CertificateVerify(undefined as any, undefined as any);
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, CertificateVerify.spec);
    return new CertificateVerify(
      //@ts-ignore
      ...Object.values(res)
    );
  }

  serialize() {
    const res = encode(this, CertificateVerify.spec).slice();
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
