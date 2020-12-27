import { HandshakeType } from "../handshake/const";
import { FragmentedHandshake } from "../record/message/fragment";

type Version = { major: number; minor: number };
type Random = { gmt_unix_time: number; random_bytes: Buffer };

type Handshake = {
  msgType: HandshakeType;
  messageSeq?: number;
  serialize: () => Buffer;
  toFragment: () => FragmentedHandshake;
};

type Extension = {
  type: number;
  data: Buffer;
};
