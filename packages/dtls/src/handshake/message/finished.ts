import { FragmentedHandshake } from "../../record/message/fragment";
import type { Handshake } from "../../typings/domain";
import { HandshakeType } from "../const";

// 7.4.9.  Finished

export class Finished implements Handshake {
  public verifyData: Buffer;

  msgType: HandshakeType = HandshakeType.finished_20;
  messageSeq?: number;

  constructor(verifyData: Buffer) {
    this.verifyData = verifyData;
  }

  static createEmpty() {
    return new Finished(undefined as any);
  }

  static deSerialize(buf: Buffer) {
    return new Finished(buf);
  }

  serialize() {
    return this.verifyData;
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
