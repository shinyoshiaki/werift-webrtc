import { binaryData } from "../../../imports/common";

import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

const { decode, encode, types } = binaryData;

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
      //@ts-expect-error
      ...Object.values(res),
    );
  }

  serialize() {
    return encode(this, ClientKeyExchange.spec);
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
