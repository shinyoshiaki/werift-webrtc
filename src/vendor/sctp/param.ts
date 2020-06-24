import { jspack } from "jspack";
import { range } from "lodash";

export class StreamResetOutgoingParam {
  static type = 13;

  constructor(
    public requestSequence: number,
    public responseSequence: number,

    public lastTsn: number,
    public streams: number[]
  ) {}

  get type() {
    return StreamResetOutgoingParam.type;
  }

  get bytes() {
    const data = Buffer.from(
      jspack.Pack("!LLL", [
        this.requestSequence,
        this.responseSequence,
        this.lastTsn,
      ])
    );

    return Buffer.concat([
      data,
      ...this.streams.map((stream) => Buffer.from(jspack.Pack("!H", [stream]))),
    ]);
  }

  static parse(data: Buffer) {
    const [requestSequence, responseSequence, lastTsn] = jspack.Unpack(
      "!LLL",
      data
    );
    const stream = range(12, data.length, 2).map(
      (pos) => jspack.Unpack("!H", data.slice(pos))[0]
    );

    return new StreamResetOutgoingParam(
      requestSequence,
      responseSequence,
      lastTsn,
      stream
    );
  }
}

export class StreamAddOutgoingParam {
  static type = 17;
  constructor(public requestSequence: number, public newStreams: number) {}

  get type() {
    return StreamAddOutgoingParam.type;
  }

  get bytes() {
    return Buffer.from(
      jspack.Pack("!LHH", [this.requestSequence, this.newStreams, 0])
    );
  }

  static parse(data: Buffer) {
    const [requestSequence, newStreams] = jspack.Unpack("!LHH", data);
    return new StreamAddOutgoingParam(requestSequence, newStreams);
  }
}

export class StreamResetResponseParam {
  static type = 16;
  constructor(public requestSequence: number, public result: number) {}

  get type() {
    return StreamResetResponseParam.type;
  }

  get bytes() {
    return Buffer.from(jspack.Pack("!LL", [this.requestSequence, this.result]));
  }

  static parse(data: Buffer) {
    const [requestSequence, result] = jspack.Unpack("!LL", data);
    return new StreamResetResponseParam(requestSequence, result);
  }
}

export const RECONFIG_PARAM_TYPES = {
  13: StreamResetOutgoingParam,
  16: StreamResetResponseParam,
  17: StreamAddOutgoingParam,
};

export type StreamParam =
  | StreamResetOutgoingParam
  | StreamAddOutgoingParam
  | StreamResetResponseParam;
