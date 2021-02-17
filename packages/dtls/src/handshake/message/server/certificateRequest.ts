import { encode, types, decode } from "binary-data";
import { HandshakeType } from "../../const";
import {
  ClientCertificateType,
  DistinguishedName,
  SignatureAlgorithm,
} from "../../binary";
import { Handshake } from "../../../typings/domain";
import { FragmentedHandshake } from "../../../record/message/fragment";
import { SignatureAlgorithms } from "../../../cipher/const";

// 7.4.4.  Certificate Request

export class ServerCertificateRequest implements Handshake {
  msgType = HandshakeType.certificate_request;
  messageSeq?: number;
  static readonly spec = {
    certificateTypes: types.array(ClientCertificateType, types.uint8, "bytes"),
    signatures: types.array(SignatureAlgorithm, types.uint16be, "bytes"),
    authorities: types.array(DistinguishedName, types.uint16be, "bytes"),
  };

  constructor(
    public certificateTypes: number[],
    public signatures: { hash: number; signature: SignatureAlgorithms }[],
    public authorities: number[]
  ) {}

  static createEmpty() {
    return new ServerCertificateRequest(
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  static deSerialize(buf: Buffer) {
    return new ServerCertificateRequest(
      //@ts-ignore
      ...Object.values(decode(buf, ServerCertificateRequest.spec))
    );
  }

  serialize() {
    const res = encode(this, ServerCertificateRequest.spec).slice();
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
