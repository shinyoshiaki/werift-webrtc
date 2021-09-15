import { DataChunk } from "../src/chunk";
import { enumerate } from "../src/helper";
import { InboundStream } from "../src/sctp";

describe("SctpStreamTest", () => {
  test("test_duplicate", (done) => {
    const factory = new ChunkFactory();

    const stream = new InboundStream();
    const chunks = factory.create([
      Buffer.from("foo"),
      Buffer.from("bar"),
      Buffer.from("baz"),
    ]);

    stream.addChunk(chunks[0]);
    expect(stream.reassembly).toEqual([chunks[0]]);
    expect(stream.streamSequenceNumber).toBe(0);

    stream.popMessages();
    expect(stream.reassembly).toEqual([chunks[0]]);
    expect(stream.streamSequenceNumber).toEqual(0);

    try {
      stream.addChunk(chunks[0]);
    } catch (error: any) {
      expect(error.message).toBe("duplicate chunk in reassembly");
      done();
    }
  });

  test("test_whole_in_order", () => {
    const factory = new ChunkFactory();

    const stream = new InboundStream();
    const chunks = [
      ...factory.create([Buffer.from("foo")]),
      ...factory.create([Buffer.from("bar")]),
    ];

    stream.addChunk(chunks[0]);
    expect(stream.reassembly).toEqual([chunks[0]]);
    expect(stream.streamSequenceNumber).toEqual(0);

    expect([...stream.popMessages()]).toEqual([[456, 123, Buffer.from("foo")]]);
    expect(stream.reassembly).toEqual([]);
    expect(stream.streamSequenceNumber).toEqual(1);

    stream.addChunk(chunks[1]);
    expect(stream.reassembly).toEqual([chunks[1]]);
    expect(stream.streamSequenceNumber).toEqual(1);

    expect([...stream.popMessages()]).toEqual([[456, 123, Buffer.from("bar")]]);
    expect(stream.reassembly).toEqual([]);
    expect(stream.streamSequenceNumber).toEqual(2);
  });
});

class ChunkFactory {
  streamSeq = 0;
  constructor(private tsn = 1) {}

  create(frags: Buffer[], ordered = true) {
    const chunks: DataChunk[] = [];

    for (const [i, frag] of enumerate(frags)) {
      let flags = 0;
      if (!ordered) flags |= SCTP_DATA_UNORDERED;
      if (i === 0) flags |= SCTP_DATA_FIRST_FRAG;
      if (i === frags.length - 1) flags |= SCTP_DATA_LAST_FRAG;

      const chunk = new DataChunk(flags, undefined);
      chunk.protocol = 123;
      chunk.streamId = 456;
      if (ordered) chunk.streamSeqNum = this.streamSeq;
      chunk.tsn = this.tsn;
      chunk.userData = frag;
      chunks.push(chunk);

      this.tsn += 1;
    }

    if (ordered) this.streamSeq += 1;

    return chunks;
  }
}

const SCTP_DATA_LAST_FRAG = 0x01;
const SCTP_DATA_FIRST_FRAG = 0x02;
const SCTP_DATA_UNORDERED = 0x04;
