import { encode, types, decode } from "binary-data";
import { HandshakeType } from "../../const";
import { ExtensionList } from "../../binary";
import { FragmentedHandshake } from "../../../record/message/fragment";
import { DtlsRandom } from "../../random";

// 7.4.1.2.  Client Hello

export class ClientHello {
  msgType = HandshakeType.client_hello;
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
    public clientVersion: { major: number; minor: number },
    public random: { gmt_unix_time: number; random_bytes: Buffer },
    public sessionId: Buffer,
    public cookie: Buffer,
    public cipherSuites: number[],
    public compressionMethods: number[],
    public extensions: { type: number; data: Buffer }[]
  ) {}

  static createEmpty() {
    return new ClientHello(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  static deSerialize(buf: Buffer) {
    return new ClientHello(
      //@ts-ignore
      ...Object.values(decode(buf, ClientHello.spec))
    );
  }

  static from(spec: typeof ClientHello.spec) {
    //@ts-ignore
    return new ClientHello(...Object.values(spec));
  }

  serialize() {
    const res = encode(this, ClientHello.spec).slice();
    return Buffer.from(res);
  }

  toFragment() {
    const body = this.serialize();
    return new FragmentedHandshake(
      this.msgType,
      body.length,
      this.messageSeq,
      0,
      body.length,
      body
    );
  }
}
