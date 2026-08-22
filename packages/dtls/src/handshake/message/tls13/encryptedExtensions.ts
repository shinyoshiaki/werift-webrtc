import { decode, encode, types } from "@shinyoshiaki/binary-data";

import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Extension, Handshake } from "../../../typings/domain";
import { ExtensionList } from "../../binary";
import { HandshakeType } from "../../const";

// HandshakeType.encrypted_extensions = 8 (TLS 1.3)

export class EncryptedExtensions implements Handshake {
  msgType = HandshakeType.encrypted_extensions_8 as any;
  messageSeq?: number;

  static readonly spec = {
    extensions: ExtensionList,
  };

  constructor(public extensions: Extension[] = []) {}

  static createEmpty() {
    return new EncryptedExtensions([]);
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, EncryptedExtensions.spec) as {
      extensions: Extension[];
    };
    return new EncryptedExtensions(res.extensions ?? []);
  }

  serialize() {
    return Buffer.from(encode(this, EncryptedExtensions.spec).slice());
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
