import { describe, expect, test } from "vitest";
import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { JitterBufferBase } from "../../../src/extra/processor/jitterBuffer";
import {
  createJitterArrivals,
  findMissingRanges,
  opusJitterStream,
  runJitterBuffer,
} from "../../utils";
import { createRandomJitterOrder } from "./generator";

/**
 * Jitter buffer property: for random loss, duplication and reordering of an
 * Opus stream (20 ms, latency 200 ms) starting at sequence numbers around the
 * 16-bit wrap:
 * - when every delay stays within the latency, the output is the received
 *   packets once each in order, and the loss reports name exactly the
 *   missing ranges;
 * - when packets exceed the latency, the output stays ordered without
 *   duplicates and every index up to the last output is either output or
 *   reported lost, once.
 *
 * CI runs `WERIFT_RTP_JITTER_SEEDS` (default 24) seeds of
 * `WERIFT_RTP_JITTER_STEPS` (default 3000) packets from
 * `WERIFT_RTP_JITTER_SEED` (default 1), for each start sequence number. A
 * failing title prints the replay environment.
 */
describe(
  "jitter buffer under random loss, duplication and reordering (property)",
  propertyOptions(),
  () => {
    const { seeds, steps, title } = propertySeeds("WERIFT_RTP_JITTER", {
      seeds: 24,
      steps: 3000,
    });
    const casesFor = (startSeqs: number[]) =>
      seeds.flatMap((seed) =>
        startSeqs.map((startSeq) => ({ seed, startSeq })),
      );

    test.each(casesFor([0, 65000, 65530, 65534, 65535]))(
      title(
        "outputs every received packet once and in order when delay stays within latency (startSeq $startSeq)",
      ),
      ({ seed, startSeq }) => {
        // Arrange: 遅れは最大 5 パケット (100ms) で latency 200ms 未満に収まる
        const rng = seededRandom(seed * 65537 + startSeq).next;
        const stream = opusJitterStream(startSeq, Math.floor(rng() * 2 ** 32));
        const { order, received } = createRandomJitterOrder({
          count: steps,
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
        expect(run.output).toEqual(received);
        expect(run.lost).toEqual(findMissingRanges(received));
      },
    );

    test.each(casesFor([0, 65534]))(
      title(
        "keeps output ordered and loss reports consistent when packets exceed latency (startSeq $startSeq)",
      ),
      ({ seed, startSeq }) => {
        // Arrange: latency を超えて遅れるパケットや重複を含む
        const rng = seededRandom(seed * 7919 + startSeq).next;
        const stream = opusJitterStream(startSeq);
        const { order, received } = createRandomJitterOrder({
          count: steps,
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
        expect(unordered).toEqual([]);
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
        const wrong = [...Array(run.output.at(-1)! + 1).keys()].filter(
          (i) => covered.get(i) !== 1,
        );
        expect(wrong).toEqual([]);
      },
    );
  },
);
