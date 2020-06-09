import {
  SCTP_DATA_UNORDERED,
  SCTP_DATA_FIRST_FRAG,
  SCTP_DATA_LAST_FRAG,
  InboundStream,
} from "../../../../src/rtc/transport/sctp/sctp";
import { DataChunk } from "../../../../src/rtc/transport/sctp/chunk";

describe.only("SctpStreamTest", () => {
  test("test_duplicate", (done) => {
    const factory = new ChunkFactory();
    const stream = new InboundStream();
    const chunks = factory.crate([
      Buffer.from("foo"),
      Buffer.from("bar"),
      Buffer.from("baz"),
    ]);

    stream.addChunk(chunks[0]);
    expect(stream.reassembly).toEqual([chunks[0]]);
    expect(stream.sequenceNumber).toBe(0);

    try {
      stream.addChunk(chunks[0]);
    } catch (error) {
      expect(error.message).toBe("duplicate chunk in reassembly");
      done();
    }
  });
});

class ChunkFactory {
  streamSeq = 0;
  constructor(private tsn = 1) {}

  crate(frags: Buffer[] = [], ordered = true) {
    const chunks: DataChunk[] = [];

    frags.forEach((frag, i) => {
      let flags = 0;
      if (!ordered) {
        flags = flags | SCTP_DATA_UNORDERED;
      }
      if (i === 0) {
        flags = flags | SCTP_DATA_FIRST_FRAG;
      }
      if (i === frags.length - 1) {
        flags = flags | SCTP_DATA_LAST_FRAG;
      }

      const chunk = new DataChunk(flags, undefined);
      chunk.protocol = 123;
      chunk.streamId = 456;
      if (ordered) {
        chunk.streamSeq = this.streamSeq;
      }
      chunk.tsn = this.tsn;
      chunk.userData = frag;
      chunks.push(chunk);

      this.tsn++;
    });

    if (ordered) this.streamSeq++;

    return chunks;
  }
}
