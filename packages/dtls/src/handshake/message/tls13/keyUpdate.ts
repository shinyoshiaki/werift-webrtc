import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Handshake } from "../../../typings/domain";
import { HandshakeType } from "../../const";

/** HandshakeType.key_update = 24 */
export class KeyUpdate implements Handshake {
  msgType = HandshakeType.key_update_24 as any;
  messageSeq?: number;

  constructor(public requestUpdate: boolean) {}

  static createEmpty() {
    return new KeyUpdate(false);
  }

  static deSerialize(buf: Buffer): KeyUpdate {
    if (buf.length < 1) throw new Error("KeyUpdate: truncated");
    return new KeyUpdate(buf[0] === 1);
  }

  serialize(): Buffer {
    return Buffer.from([this.requestUpdate ? 1 : 0]);
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
