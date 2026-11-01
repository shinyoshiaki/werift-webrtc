import { RtpHeader, RtpPacket } from "../../src";
import { JitterBufferBase } from "../../src/extra/processor/jitterBuffer";
import { JitterBufferTransformer } from "../../src/extra/processor/jitterBufferTransformer";
import {
  createJitterArrivals,
  createJitterRtp,
  createPrng,
  createRandomJitterOrder,
  findMissingRanges,
  type JitterStream,
  runJitterBuffer,
} from "../utils";

describe("test JitterBuffer", () => {
  const createRtpPacket = (sequenceNumber: number, timestamp: number) =>
    new RtpPacket(
      new RtpHeader({ sequenceNumber, timestamp }),
      Buffer.from([1, 2, 3]),
    );

  it("handle continues packet", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    for (let i = 0; i < 5; i++) {
      writer.write({ rtp: createRtpPacket(i, i) });
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(i);
    }
  });

  it("handle jitter", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    writer.write({ rtp: createRtpPacket(0, 0) });
    await reader.read();

    writer.write({ rtp: createRtpPacket(2, 2) });
    writer.write({ rtp: createRtpPacket(1, 1) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(1);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(2);
    }
    writer.write({ rtp: createRtpPacket(3, 3) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(3);
    }
  });

  it("should packet loss", async () => {
    const jitterBuffer = new JitterBufferTransformer(90000);
    const writer = jitterBuffer.transform.writable.getWriter();
    const reader = jitterBuffer.transform.readable.getReader();

    writer.write({ rtp: createRtpPacket(0, 0) });
    await reader.read();

    writer.write({ rtp: createRtpPacket(2, 2) });
    writer.write({ rtp: createRtpPacket(3, 3) });
    writer.write({ rtp: createRtpPacket(4, 4 + 90000 * 1) });
    const res = (await reader.read()).value!;
    expect(res.isPacketLost).toEqual({ from: 1, to: 1 });
    //@ts-expect-error
    expect(jitterBuffer.presentSeqNum).toBe(4);

    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(2);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(3);
    }
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(4);
    }

    writer.write({ rtp: createRtpPacket(5, 5) });
    {
      const res = (await reader.read()).value!;
      expect(res.rtp!.header.sequenceNumber).toBe(5);
    }
  });

  it("keeps received packets when one packet is lost and reception continues", () => {
    // Arrange: 20ms 間隔のパケット 0〜30 のうち 1 だけが欠落する。
    const jitterBuffer = new JitterBufferBase(48000, { latency: 200 });
    const received: number[] = [];
    const lost: { from: number; to: number }[] = [];

    // Act
    for (let i = 0; i <= 30; i++) {
      if (i === 1) {
        continue;
      }
      for (const out of jitterBuffer.processInput({
        rtp: createRtpPacket(i, i * 960),
      })) {
        if (out.rtp) received.push(out.rtp.header.sequenceNumber);
        if (out.isPacketLost) lost.push(out.isPacketLost);
      }
    }
    for (const out of jitterBuffer.processInput({ eol: true })) {
      if (out.rtp) received.push(out.rtp.header.sequenceNumber);
    }

    // Assert: 欠落した 1 以外の全パケットが、重複なく順序どおり出力される。
    expect(received).toEqual([
      0,
      ...Array.from({ length: 29 }, (_, i) => i + 2),
    ]);
    // Assert: 欠落通知は 1 のみを指す。
    expect(lost.length).toBeGreaterThan(0);
    expect(lost[0].from).toBe(1);
  });

  // 20ms 間隔 (48kHz) の Opus を latency 200ms で扱う
  const opus = (startSeq: number, startTs = 0): JitterStream => ({
    startSeq,
    startTs,
    step: 960,
  });
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const without = (indices: number[], ...excluded: number[]) =>
    indices.filter((i) => !excluded.includes(i));

  describe.each([0, 100, 65530, 65534, 65535])(
    "loss and reordering (startSeq %i)",
    (startSeq) => {
      const stream = opus(startSeq);

      it("keeps a packet that arrives within latency after an earlier loss timed out", () => {
        // Arrange: 1 が欠落し、1 のタイムアウトと同時期に 13 と 12 が入れ替わって届く
        const order = [0, ...range(2, 11), 13, 12, ...range(14, 30)];

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 受信した全パケットが 1 回ずつ番号順に出力され、欠落通知は 1 だけを指す
        expect(run.output).toEqual(without(range(0, 30), 1));
        expect(run.lost).toEqual([{ from: 1, to: 1 }]);
      });

      it("keeps both packets of a swap that straddles the timeout", () => {
        // Arrange: 1 が欠落し、13 と 14 が入れ替わって届く
        const order = [0, ...range(2, 12), 14, 13, ...range(15, 30)];

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 13 と 14 がどちらも番号順に出力される
        expect(run.output).toEqual(without(range(0, 30), 1));
        expect(run.lost).toEqual([{ from: 1, to: 1 }]);
      });

      it("reports each of two separate losses", () => {
        // Arrange: 1 と 12 の 2 箇所が欠落する
        const order = without(range(0, 40), 1, 12);

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 受信分はすべて出力され、欠落通知は 1 と 12 の 2 件が欠落位置に出る
        expect(run.output).toEqual(order);
        expect(run.lost).toEqual([
          { from: 1, to: 1 },
          { from: 12, to: 12 },
        ]);
        expect(run.events.slice(0, 3)).toEqual([
          { rtp: 0 },
          { lost: { from: 1, to: 1 } },
          { rtp: 2 },
        ]);
      });

      it("reports a burst loss as one range", () => {
        // Arrange: 3〜7 が連続して欠落する
        const order = without(range(0, 30), 3, 4, 5, 6, 7);

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 欠落区間 3〜7 が 1 件で通知される
        expect(run.output).toEqual(order);
        expect(run.lost).toEqual([{ from: 3, to: 7 }]);
      });

      it("drops duplicates and packets that arrive after their loss was given up", () => {
        // Arrange: 5 が重複し、1 はタイムアウト後に届く
        const order = [0, ...range(2, 5), 5, ...range(6, 15), 1, 5, 16];

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 出力は番号順で重複がなく、諦めた 1 は後から出力されない
        expect(run.output).toEqual(without(range(0, 16), 1));
        expect(run.lost).toEqual([{ from: 1, to: 1 }]);
      });

      it("releases buffered packets in order at eol", () => {
        // Arrange: 1 が欠落したまま、タイムアウト前に録音が終わる
        const order = [0, 3, 2, 4];

        // Act: 到着順に入力し、最後に eol を入れる
        const run = runJitterBuffer(
          new JitterBufferBase(48000, { latency: 200 }),
          createJitterArrivals(order, stream),
          stream,
        );

        // Assert: 残っていたパケットが番号順に出力され、欠落通知も出る
        expect(run.output).toEqual([0, 2, 3, 4]);
        expect(run.lost).toEqual([{ from: 1, to: 1 }]);
      });
    },
  );

  it("handles RTP timestamp wraparound", () => {
    // Arrange: RTP timestamp が途中で 2^32 を折り返し、1 が欠落する
    const stream = opus(65534, 2 ** 32 - 960 * 5);
    const order = [0, ...range(2, 11), 13, 12, ...range(14, 30)];

    // Act: 到着順に入力し、最後に eol を入れる
    const run = runJitterBuffer(
      new JitterBufferBase(48000, { latency: 200 }),
      createJitterArrivals(order, stream),
      stream,
    );

    // Assert: 折り返しをまたいでも受信分がすべて番号順に出力される
    expect(run.output).toEqual(without(range(0, 30), 1));
    expect(run.lost).toEqual([{ from: 1, to: 1 }]);
  });

  it("does not drop buffered packets when an in-order packet triggers a timeout", () => {
    // Arrange: 2 が欠落した状態で、時刻が大きく進んだ 1 が順番どおりに届く
    const stream = opus(0);
    const arrivals = createJitterArrivals([0, 3], stream);
    const late = createJitterRtp(1, stream);
    late.header.timestamp = 48000;
    arrivals.push(late, ...createJitterArrivals([4, 5], stream));

    // Act: 到着順に入力し、最後に eol を入れる
    const run = runJitterBuffer(
      new JitterBufferBase(48000, { latency: 200 }),
      arrivals,
      stream,
    );

    // Assert: タイムアウトした 3 も捨てられずに出力される
    expect(run.output).toEqual([0, 1, 3, 4, 5]);
    expect(run.lost).toEqual([{ from: 2, to: 2 }]);
  });

  it("releases packets instead of dropping them when the buffer is full", () => {
    // Arrange: タイムアウトしない長い latency で、小さいバッファに欠落後のパケットが溜まる
    const stream = opus(0);
    const order = without(range(0, 20), 1);

    // Act: 到着順に入力し、最後に eol を入れる
    const run = runJitterBuffer(
      new JitterBufferBase(48000, { latency: 10_000, bufferSize: 4 }),
      createJitterArrivals(order, stream),
      stream,
    );

    // Assert: バッファ上限を超えても受信分はすべて番号順に出力される
    expect(run.output).toEqual(order);
    expect(run.lost).toEqual([{ from: 1, to: 1 }]);
  });

  describe("randomized loss, duplication and reordering", () => {
    const seeds = range(1, 25);

    it.each([0, 65000, 65530, 65534, 65535])(
      "outputs every received packet once and in order when delay stays within latency (startSeq %i)",
      (startSeq) => {
        for (const seed of seeds) {
          // Arrange: 遅れは最大 5 パケット (100ms) で latency 200ms 未満に収まる
          const rng = createPrng(seed * 65537 + startSeq);
          const stream = opus(startSeq, Math.floor(rng() * 2 ** 32));
          const { order, received } = createRandomJitterOrder({
            count: 3000,
            rng,
            lossRate: 0.05,
            duplicateRate: 0.05,
            maxDelay: 5,
          });

          // Act: 到着順に入力し、最後に eol を入れる
          const run = runJitterBuffer(
            new JitterBufferBase(48000, { latency: 200 }),
            createJitterArrivals(order, stream),
            stream,
          );

          // Assert: 出力は受信集合を番号順に並べたものと一致し、欠落通知は実際の欠落区間だけを指す
          expect({ seed, output: run.output }).toEqual({
            seed,
            output: received,
          });
          expect({ seed, lost: run.lost }).toEqual({
            seed,
            lost: findMissingRanges(received),
          });
        }
      },
    );

    it.each([0, 65534])(
      "keeps output ordered and loss reports consistent when packets exceed latency (startSeq %i)",
      (startSeq) => {
        for (const seed of seeds) {
          // Arrange: latency を超えて遅れるパケットや重複を含む
          const rng = createPrng(seed * 7919 + startSeq);
          const stream = opus(startSeq);
          const { order, received } = createRandomJitterOrder({
            count: 3000,
            rng,
            lossRate: 0.05,
            duplicateRate: 0.1,
            maxDelay: 30,
            duplicateMaxDelay: 60,
          });

          // Act: 到着順に入力し、最後に eol を入れる
          const run = runJitterBuffer(
            new JitterBufferBase(48000, { latency: 200 }),
            createJitterArrivals(order, stream),
            stream,
          );

          // Assert: 出力は重複なく番号順で、受信したパケットだけを含む
          const unordered = run.output.filter(
            (index, i) => i > 0 && index <= run.output[i - 1],
          );
          expect({ seed, unordered }).toEqual({ seed, unordered: [] });
          const receivedSet = new Set(received);
          expect(run.output.every((i) => receivedSet.has(i))).toBe(true);
          // Assert: 出力範囲の各番号は「出力」か「欠落通知」のどちらか一方だけに含まれる
          const covered = new Map<number, number>();
          for (const i of run.output) covered.set(i, (covered.get(i) ?? 0) + 1);
          for (const { from, to } of run.lost) {
            for (let i = from; i <= to; i++) {
              covered.set(i, (covered.get(i) ?? 0) + 1);
            }
          }
          for (let i = 0; i <= run.output.at(-1)!; i++) {
            expect({ seed, i, count: covered.get(i) }).toEqual({
              seed,
              i,
              count: 1,
            });
          }
        }
      },
    );
  });
});
