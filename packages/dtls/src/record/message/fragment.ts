/* eslint-disable @typescript-eslint/ban-ts-comment */
import { decode, encode, types } from "binary-data";

import { HandshakeType } from "../../handshake/const";
import { getObjectSummary } from "../../helper";

export class FragmentedHandshake {
  static readonly spec = {
    msg_type: types.uint8,
    length: types.uint24be,
    message_seq: types.uint16be,
    fragment_offset: types.uint24be,
    fragment_length: types.uint24be,
    fragment: types.buffer((context: any) => context.current.fragment_length),
  };

  constructor(
    public msg_type: number,
    public length: number,
    public message_seq: number,
    public fragment_offset: number,
    public fragment_length: number,
    public fragment: Buffer
  ) {}

  get summary() {
    return getObjectSummary(this);
  }

  static createEmpty() {
    return new FragmentedHandshake(
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  static deSerialize(buf: Buffer) {
    return new FragmentedHandshake(
      //@ts-ignore
      ...Object.values(decode(buf, FragmentedHandshake.spec))
    );
  }

  serialize() {
    const res = encode(this, FragmentedHandshake.spec).slice();
    return Buffer.from(res);
  }

  chunk(maxFragmentLength?: number): FragmentedHandshake[] {
    let start = 0;
    const totalLength = this.fragment.length;

    if (totalLength === 0)
      return [
        new FragmentedHandshake(
          this.msg_type,
          totalLength,
          this.message_seq,
          start,
          0,
          this.fragment
        ),
      ];

    const fragments: FragmentedHandshake[] = [];
    if (!maxFragmentLength) {
      maxFragmentLength = 1280 - (20 + 8) - (1 + 3 + 2 + 3 + 3);
    }
    // loop through the message and fragment it
    while (start < totalLength) {
      // calculate maximum length, limited by MTU - IP/UDP headers - handshake overhead
      const fragmentLength = Math.min(maxFragmentLength, totalLength - start);
      // slice and dice
      const data = Buffer.from(
        this.fragment.slice(start, start + fragmentLength)
      );
      if (data.length <= 0) {
        // this shouldn't happen, but we don't want to introduce an infinite loop
        throw new Error(
          `Zero or less bytes processed while fragmenting handshake message.`
        );
      }
      // create the message
      fragments.push(
        new FragmentedHandshake(
          this.msg_type,
          totalLength,
          this.message_seq,
          start,
          data.length,
          data
        )
      );
      // step forward by the actual fragment length
      start += data.length;
    }

    return fragments;
  }

  static assemble(messages: FragmentedHandshake[]): FragmentedHandshake {
    // cannot reassemble empty arrays
    if (!(messages && messages.length)) {
      throw new Error("cannot reassemble handshake from empty array");
    }

    // sort by fragment start
    messages = messages.sort((a, b) => a.fragment_offset - b.fragment_offset);
    // combine into a single buffer
    const combined = Buffer.alloc(messages[0].length);
    for (const msg of messages) {
      msg.fragment.copy(combined, msg.fragment_offset);
    }

    // and return the complete message
    return new FragmentedHandshake(
      messages[0].msg_type,
      messages[0].length,
      messages[0].message_seq,
      0,
      combined.length,
      combined
    );
  }

  static findAllFragments(
    fragments: FragmentedHandshake[],
    type: HandshakeType
  ): FragmentedHandshake[] {
    const reference = fragments.find((v) => v.msg_type === type);
    if (!reference) return [];

    // ignore empty arrays
    if (!(fragments && fragments.length)) return [];

    // return all fragments with matching msg_type, message_seq and total length
    return fragments.filter((f) => {
      return (
        f.msg_type === reference.msg_type &&
        f.message_seq === reference.message_seq &&
        f.length === reference.length
      );
    });
  }
}
