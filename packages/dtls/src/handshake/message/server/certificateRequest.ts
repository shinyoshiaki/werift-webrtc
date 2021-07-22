import { decode, encode, types } from "binary-data";

import { HashAlgorithms, SignatureAlgorithms } from "../../../cipher/const";
import { FragmentedHandshake } from "../../../record/message/fragment";
import { Handshake } from "../../../typings/domain";
import {
  ClientCertificateType,
  DistinguishedName,
  SignatureHashAlgorithm,
} from "../../binary";
import { HandshakeType } from "../../const";

// 7.4.4.  Certificate Request

export class ServerCertificateRequest implements Handshake {
  msgType = HandshakeType.certificate_request_13;
  messageSeq?: number;
  static readonly spec = {
    certificateTypes: types.array(ClientCertificateType, types.uint8, "bytes"),
    signatures: types.array(SignatureHashAlgorithm, types.uint16be, "bytes"),
    authorities: types.array(DistinguishedName, types.uint16be, "bytes"),
  };

  constructor(
    public certificateTypes: number[],
    public signatures: {
      hash: HashAlgorithms;
      signature: SignatureAlgorithms;
    }[],
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
