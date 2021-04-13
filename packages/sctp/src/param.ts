import { jspack } from "jspack";
import { range } from "lodash";

// This parameter is used by the sender to request the reset of some or
// all outgoing streams.
//  0                   1                   2                   3
//  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |     Parameter Type = 13       | Parameter Length = 16 + 2 * N |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |           Re-configuration Request Sequence Number            |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |           Re-configuration Response Sequence Number           |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                Sender's Last Assigned TSN                     |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |  Stream Number 1 (optional)   |    Stream Number 2 (optional) |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// /                            ......                             /
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |  Stream Number N-1 (optional) |    Stream Number N (optional) |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export class OutgoingSSNResetRequestParam {
  static type = 13; // Outgoing SSN Reset Request Parameter

  constructor(
    public requestSequence: number,
    public responseSequence: number,
    public lastTsn: number,
    public streams: number[]
  ) {}

  get type() {
    return OutgoingSSNResetRequestParam.type;
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

    return new OutgoingSSNResetRequestParam(
      requestSequence,
      responseSequence,
      lastTsn,
      stream
    );
  }
}

export class StreamAddOutgoingParam {
  static type = 17; // Add Outgoing Streams Request Parameter

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

// This parameter is used by the receiver of a Re-configuration Request
// Parameter to respond to the request.
//
// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |     Parameter Type = 16       |      Parameter Length         |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |         Re-configuration Response Sequence Number             |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                            Result                             |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                   Sender's Next TSN (optional)                |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                  Receiver's Next TSN (optional)               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

export const reconfigResult = {
  ReconfigResultSuccessPerformed: 1,
  BadSequenceNumber: 5,
} as const;
type ReconfigResult = typeof reconfigResult[keyof typeof reconfigResult];

export class ReconfigResponseParam {
  static type = 16; // Re-configuration Response Parameter
  constructor(public responseSequence: number, public result: ReconfigResult) {}

  get type() {
    return ReconfigResponseParam.type;
  }

  get bytes() {
    return Buffer.from(
      jspack.Pack("!LL", [this.responseSequence, this.result])
    );
  }

  static parse(data: Buffer) {
    const [requestSequence, result] = jspack.Unpack("!LL", data);
    return new ReconfigResponseParam(requestSequence, result as ReconfigResult);
  }
}

export type StreamParam =
  | OutgoingSSNResetRequestParam
  | StreamAddOutgoingParam
  | ReconfigResponseParam;

export type StreamParamType =
  | typeof OutgoingSSNResetRequestParam
  | typeof StreamAddOutgoingParam
  | typeof ReconfigResponseParam;

export const RECONFIG_PARAM_BY_TYPES: { [type: number]: StreamParamType } = {
  13: OutgoingSSNResetRequestParam, // Outgoing SSN Reset Request Parameter
  16: ReconfigResponseParam, // Re-configuration Response Parameter
  17: StreamAddOutgoingParam, // Add Outgoing Streams Request Parameter
};
