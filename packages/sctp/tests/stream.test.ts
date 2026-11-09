import { DataChunk } from "../src/chunk";
import { enumerate } from "../src/helper";
import { InboundStream } from "../src/sctp";

describe("SctpStreamTest", () => {
  test("test_duplicate", (done) =>
    new Promise<void>((done) => {
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
    }));

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

  test("delivers the next ordered message even when its TSN is not contiguous", () => {
    // Arrange: SSN 0 (TSN 1) と SSN 1 (TSN 3) の間の TSN 2 は別ストリーム宛てで、このストリームには来ない
    const factory = new ChunkFactory();
    const stream = new InboundStream();
    const [foo] = factory.create([Buffer.from("foo")]);
    factory.create([Buffer.from("other")], false);
    const [bar] = factory.create([Buffer.from("bar")]);

    // Act: 後続の SSN 1 を先に受け取り、続いて SSN 0 を受け取って取り出す
    stream.addChunk(bar);
    const before = [...stream.popMessages()];
    stream.addChunk(foo);
    const after = [...stream.popMessages()];

    // Assert: SSN 0 の配送に続けて、TSN が連続しない SSN 1 も同じ呼び出しで配送される
    expect(before).toEqual([]);
    expect(after.map(([, , data]) => data.toString())).toEqual(["foo", "bar"]);
    expect(stream.reassembly).toEqual([]);
    expect(stream.streamSequenceNumber).toBe(2);
  });

  test("delivers an unordered message that directly follows a broken unordered fragment", () => {
    // Arrange: 順序なし断片化メッセージの先頭断片だけ (残りは欠落) と、その直後の完全な順序なしメッセージ
    const factory = new ChunkFactory();
    const stream = new InboundStream();
    const [head] = factory.create(
      [Buffer.from("p1"), Buffer.from("p2"), Buffer.from("p3")],
      false,
    );
    const [whole] = factory.create([Buffer.from("whole")], false);

    // Act: 両方を受け取って取り出す
    stream.addChunk(head);
    stream.addChunk(whole);
    const messages = [...stream.popMessages()];

    // Assert: 不完全な断片に続く完全なメッセージが読み飛ばされず配送され、不完全な断片だけが残る
    expect(messages.map(([, , data]) => data.toString())).toEqual(["whole"]);
    expect(stream.reassembly).toEqual([head]);
  });
});

class ChunkFactory {
  private tsn: number;

  streamSeq = 0;
  constructor(tsn = 1) {
    this.tsn = tsn;
  }

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
