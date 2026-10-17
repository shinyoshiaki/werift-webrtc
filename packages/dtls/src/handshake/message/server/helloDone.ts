import { binaryData } from "../../../imports/common";

import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

const { decode, encode } = binaryData;

// 7.4.5.  Server Hello Done

export class ServerHelloDone implements Handshake {
  msgType = HandshakeType.server_hello_done_14;
  messageSeq?: number;
  static readonly spec = {};

  static createEmpty() {
    return new ServerHelloDone();
  }

  static deSerialize(buf: Buffer) {
    return new ServerHelloDone(
      //@ts-ignore
      ...Object.values(decode(buf, ServerHelloDone.spec)),
    );
  }

  serialize() {
    return encode(this, ServerHelloDone.spec);
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
