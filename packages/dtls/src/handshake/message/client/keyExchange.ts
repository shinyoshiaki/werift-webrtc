import { decode, encode, types } from "@shinyoshiaki/binary-data";

import { FragmentedHandshake } from "../../../record/message/fragment";
import { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

export class ClientKeyExchange implements Handshake {
  msgType = HandshakeType.client_key_exchange_16;
  messageSeq?: number;

  static readonly spec = {
    publicKey: types.buffer(types.uint8),
  };

  constructor(public publicKey: Buffer) {}

  static createEmpty() {
    return new ClientKeyExchange(undefined as any);
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, ClientKeyExchange.spec);
    return new ClientKeyExchange(
      //@ts-ignore
      ...Object.values(res),
    );
  }

  serialize() {
    const res = encode(this, ClientKeyExchange.spec).slice();
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
      body,
    );
  }
}
