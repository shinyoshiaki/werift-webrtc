import { binaryData } from "../../../imports/common";

import { FragmentedHandshake } from "../../../record/message/fragment";
import type { Extension } from "../../../typings/domain";
import { ExtensionList } from "../../binary";
import { HandshakeType } from "../../const";
import { DtlsRandom } from "../../random";

const { decode, encode, types } = binaryData;

// 7.4.1.2.  Client Hello

export class ClientHello {
  public clientVersion: { major: number; minor: number };
  public random: { gmt_unix_time: number; random_bytes: Buffer };
  public sessionId: Buffer;
  public cookie: Buffer;
  public cipherSuites: number[];
  public compressionMethods: number[];
  public extensions: Extension[];

  msgType: HandshakeType = HandshakeType.client_hello_1;
  messageSeq: number = 0;
  static readonly spec = {
    clientVersion: { major: types.uint8, minor: types.uint8 },
    random: DtlsRandom.spec,
    sessionId: types.buffer(types.uint8),
    cookie: types.buffer(types.uint8),
    cipherSuites: types.array(types.uint16be, types.uint16be, "bytes"),
    compressionMethods: types.array(types.uint8, types.uint8, "bytes"),
    extensions: ExtensionList,
  };

  constructor(
    clientVersion: { major: number; minor: number },
    random: { gmt_unix_time: number; random_bytes: Buffer },
    sessionId: Buffer,
    cookie: Buffer,
    cipherSuites: number[],
    compressionMethods: number[],
    extensions: Extension[],
  ) {
    this.clientVersion = clientVersion;
    this.random = random;
    this.sessionId = sessionId;
    this.cookie = cookie;
    this.cipherSuites = cipherSuites;
    this.compressionMethods = compressionMethods;
    this.extensions = extensions;
  }

  static createEmpty() {
    return new ClientHello(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
  }

  static deSerialize(buf: Buffer) {
    return new ClientHello(
      //@ts-expect-error
      ...Object.values(decode(buf, ClientHello.spec)),
    );
  }

  serialize() {
    return encode(this, ClientHello.spec);
  }

  toFragment() {
    const body = this.serialize();
    return new FragmentedHandshake(
      this.msgType,
      body.length,
      this.messageSeq,
      0,
      body.length,
      body,
    );
  }
}
