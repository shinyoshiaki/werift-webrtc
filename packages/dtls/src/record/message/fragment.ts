/* eslint-disable @typescript-eslint/ban-ts-comment */
import { decode, encode, types } from "@shinyoshiaki/binary-data";

import type { HandshakeType } from "../../handshake/const";
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
    public fragment: Buffer,
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
      undefined as any,
    );
  }

  static deSerialize(buf: Buffer) {
    return new FragmentedHandshake(
      //@ts-ignore
      ...Object.values(decode(buf, FragmentedHandshake.spec)),
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
          this.fragment,
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
        this.fragment.slice(start, start + fragmentLength),
      );
      if (data.length <= 0) {
        // this shouldn't happen, but we don't want to introduce an infinite loop
        throw new Error(
          `Zero or less bytes processed while fragmenting handshake message.`,
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
          data,
        ),
      );
      // step forward by the actual fragment length
      start += data.length;
    }

    return fragments;
  }

  static assemble(messages: FragmentedHandshake[]): FragmentedHandshake {
    // cannot reassemble empty arrays
    if (!messages?.length) {
      throw new Error("cannot reassemble handshake from empty array");
    }

    const total = messages[0].length;
    if (total < 0 || total > 0x1000000) {
      throw new Error("invalid handshake message length");
    }

    // sort by fragment start
    messages = messages.sort((a, b) => a.fragment_offset - b.fragment_offset);
    // combine into a single buffer with strict range checks
    const combined = Buffer.alloc(total);
    const covered = new Uint8Array(total);
    for (const msg of messages) {
      if (msg.length !== total) {
        throw new Error("fragment total length mismatch");
      }
      if (msg.fragment_length !== msg.fragment.length) {
        throw new Error("fragment_length does not match buffer");
      }
      if (
        msg.fragment_offset < 0 ||
        msg.fragment_length < 0 ||
        msg.fragment_offset + msg.fragment_length > total
      ) {
        throw new Error("fragment range exceeds message length");
      }
      for (let i = 0; i < msg.fragment_length; i++) {
        const idx = msg.fragment_offset + i;
        if (covered[idx]) {
          // exact-byte duplicates are OK only if same value
          if (combined[idx] !== msg.fragment[i]) {
            throw new Error("overlapping fragment conflict");
          }
        } else {
          covered[idx] = 1;
          combined[idx] = msg.fragment[i];
        }
      }
    }
    for (let i = 0; i < total; i++) {
      if (!covered[i]) {
        throw new Error("incomplete reassembly");
      }
    }

    // and return the complete message
    return new FragmentedHandshake(
      messages[0].msg_type,
      messages[0].length,
      messages[0].message_seq,
      0,
      combined.length,
      combined,
    );
  }

  static findAllFragments(
    fragments: FragmentedHandshake[],
    type: HandshakeType,
  ): FragmentedHandshake[] {
    const reference = fragments.find((v) => v.msg_type === type);
    if (!reference) return [];

    // ignore empty arrays
    if (!fragments?.length) return [];

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
