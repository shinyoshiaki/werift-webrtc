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
    // RFC 8446 §4.6.3: exactly one byte, KeyUpdateRequest update_not_requested(0)
    // or update_requested(1); other values → illegal_parameter
    if (buf.length < 1) throw new Error("KeyUpdate: truncated");
    if (buf.length !== 1) {
      throw new Error("decode_error: invalid KeyUpdate length");
    }
    if (buf[0] !== 0 && buf[0] !== 1) {
      throw new Error("illegal_parameter: invalid KeyUpdateRequest");
    }
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
