import { encode, types, decode } from "binary-data";
import { HandshakeType } from "../../const";
import { ProtocolVersion, ExtensionList } from "../../binary";
import { DtlsRandom } from "../../random";
import { Version, Random, Handshake, Extension } from "../../../typings/domain";
import { FragmentedHandshake } from "../../../record/message/fragment";

// 7.4.1.3.  Server Hello

export class ServerHello implements Handshake {
  msgType = HandshakeType.server_hello;
  messageSeq?: number;
  static readonly spec = {
    serverVersion: ProtocolVersion,
    random: DtlsRandom.spec,
    sessionId: types.buffer(types.uint8),
    cipherSuite: types.uint16be,
    compressionMethod: types.uint8,
  };

  constructor(
    public serverVersion: Version,
    public random: Random,
    public sessionId: Buffer,
    public cipherSuite: number,
    public compressionMethod: number,
    public extensions: Extension[]
  ) {}

  static createEmpty() {
    return new ServerHello(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  static deSerialize(buf: Buffer) {
    const res = decode(buf, ServerHello.spec);
    const cls = new ServerHello(
      //@ts-ignore
      ...Object.values(res)
    );
    const expect = cls.serialize();
    if (expect.length < buf.length) {
      return new ServerHello(
        //@ts-ignore
        ...Object.values(
          decode(buf, { ...ServerHello.spec, extensions: ExtensionList })
        )
      );
    }
    return cls;
  }

  serialize() {
    const res =
      this.extensions === undefined
        ? encode(this, ServerHello.spec).slice()
        : encode(this, {
            ...ServerHello.spec,
            extensions: ExtensionList,
          }).slice();
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
