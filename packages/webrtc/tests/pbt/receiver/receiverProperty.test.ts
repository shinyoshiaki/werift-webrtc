import { describe, expect, test, vi } from "vitest";
import {
  defaultPeerConfig,
  type PeerConfig,
  RtcpPacketConverter,
  type RtcpTransportLayerFeedback,
  type TransportWideCC,
} from "../../../src";
import { ReceiverTWCC } from "../../../src/media/receiver/receiverTwcc";
import {
  collectReceivedRtp,
  createMediaRtpPacket,
  createPaddingOnlyRtpPacket,
  createVideoReceiver,
} from "../../media/rtpReceiverTestUtils";
import { seededRandom } from "../shared/random";
import { propertySeeds } from "../shared/seeds";
import {
  type ReceivedStep,
  randomMediaPaddingStream,
  randomTwccArrivals,
} from "./generator";

/**
 * RTP receiver property test: claims about probe-padding compaction on
 * `onReceiveRtp` and about `ReceiverTWCC` feedback for any input a seed draws
 * (`receiver/generator.ts`).
 *
 * CI runs `WERIFT_RECEIVER_SEEDS` (default 24) seeds per property from
 * `WERIFT_RECEIVER_SEED` (default 1); `WERIFT_RECEIVER_STEPS` (default 300) is
 * the number of sequence numbers per seed. A failing title prints the replay
 * environment.
 */
const { seeds, steps, replay } = propertySeeds("WERIFT_RECEIVER", {
  seeds: 24,
  steps: 300,
});
const cases = seeds.map((seed) => ({ seed }));
const title = (claim: string) =>
  `${claim}: seed $seed (replay: ${replay("$seed")})`;

const compactPadding: PeerConfig = {
  ...defaultPeerConfig,
  filterProbePaddingOnReceiveRtp: true,
};

/** Act: receive `stream` with padding compaction enabled. */
function receiveCompacted(stream: ReceivedStep[]) {
  const { receiver, track } = createVideoReceiver({
    peerConfig: compactPadding,
  });
  const received = collectReceivedRtp(track);
  for (const step of stream) {
    const sequenceNumber = step.ext & 0xffff;
    receiver.handleRtpBySsrc(
      step.kind === "media"
        ? createMediaRtpPacket({ sequenceNumber })
        : createPaddingOnlyRtpPacket({ sequenceNumber }),
      {},
    );
  }
  return received;
}

/** Signed distance from `a` to `b` in 16-bit sequence space. */
const seqDelta = (a: number, b: number) =>
  ((((b - a) & 0xffff) + 0x8000) & 0xffff) - 0x8000;

describe("rtp receiver property", () => {
  test.each(cases)(
    title(
      "compact (順着): media の seq は padding を飛ばした分だけ詰まり、実ロスの欠番は残る",
    ),
    ({ seed }) => {
      // Arrange: 順着の media / padding 列（padding は burst、media は実ロスあり、wrap をまたぐ）
      const stream = randomMediaPaddingStream(seededRandom(seed), steps, {
        reorder: false,
      });

      // Act
      const received = receiveCompacted(stream);

      // Assert: padding は届けず、media は全件 media として届く
      const media = stream.filter((s) => s.kind === "media");
      expect(received.map((r) => r.type)).toEqual(media.map(() => "media"));
      // Assert: 出力 seq = 元の seq − それより前に届いた padding の数（mod 2^16）
      let paddingBefore = 0;
      const expected: number[] = [];
      for (const step of stream) {
        if (step.kind === "padding") paddingBefore++;
        else expected.push((step.ext - paddingBefore) & 0xffff);
      }
      expect(received.map((r) => r.seq)).toEqual(expected);
    },
  );

  test.each(cases)(
    title(
      "compact (並べ替え・重複): media の seq は同じ packet なら同じ値、異なる packet は元の順を保って一意",
    ),
    ({ seed }) => {
      // Arrange: 局所的な並べ替えと重複で、padding が後続 media より遅れて届く列
      const stream = randomMediaPaddingStream(seededRandom(seed), steps, {
        reorder: true,
      });

      // Act
      const received = receiveCompacted(stream);

      // Assert: padding は届けず、届いた media は入力の media と 1 対 1
      const media = stream.filter((s) => s.kind === "media");
      expect(received).toHaveLength(media.length);
      expect(received.every((r) => r.type === "media")).toBe(true);
      // Assert: 同じ元 seq の重複は同じ出力 seq に写る
      const outByExt = new Map<number, number>();
      media.forEach((step, i) => {
        const out = received[i]!.seq;
        expect(outByExt.get(step.ext) ?? out).toBe(out);
        outByExt.set(step.ext, out);
      });
      // Assert: 元 seq の順に並べると出力 seq も狭義単調増加（遅延 padding で重複・逆転しない）
      const byExt = [...outByExt].sort(([a], [b]) => a - b);
      for (let i = 1; i < byExt.length; i++) {
        expect(seqDelta(byExt[i - 1]![1], byExt[i]![1])).toBeGreaterThan(0);
      }
    },
  );

  test.each(cases)(
    title(
      "twcc feedback: 受信した TSN は受信として 1 回だけ報告され、欠番は未受信としてだけ報告される（報告窓を埋める長い欠落は飛ばしても報告が再開する）",
    ),
    ({ seed }) => {
      // Arrange: 順着の TSN（短い / 長い / 報告窓ほどの欠番、wrap をまたぐ）と、ランダムな feedback 送信点
      const arrivals = randomTwccArrivals(seededRandom(seed), steps);
      const sendRtcp = vi.fn(async (_packets: unknown[]) => {});
      const rx = new ReceiverTWCC({ sendRtcp } as never, 1, 2);
      rx.twccRunning = false;

      // Act: 受信し、送信点と最後に feedback を出させる
      for (const { ext, flush } of arrivals) {
        rx.handleTWCC(ext & 0xffff);
        if (flush) (rx as any).sendTWCC();
      }
      (rx as any).sendTWCC();

      // Assert: wire 形式から読み戻した報告を拡張番号ごとに集計する
      const receivedCount = new Map<number, number>();
      const reportedLost = new Set<number>();
      let near = arrivals[0]!.ext;
      for (const [packets] of sendRtcp.mock.calls) {
        for (const packet of packets as { serialize(): Buffer }[]) {
          const [rtpfb] = RtcpPacketConverter.deSerialize(
            packet.serialize(),
          ) as [RtcpTransportLayerFeedback];
          for (const r of (rtpfb.feedback as TransportWideCC).packetResults) {
            // 受信側と同じく、ちょうど半周の差は前方とみなす
            const delta = seqDelta(near, r.sequenceNumber);
            const ext = near + (delta === -0x8000 ? 0x8000 : delta);
            near = ext;
            if (r.received)
              receivedCount.set(ext, (receivedCount.get(ext) ?? 0) + 1);
            else reportedLost.add(ext);
          }
        }
      }
      // Assert: 受信した TSN はちょうど 1 回、受信として報告される
      const arrived = new Set(arrivals.map((a) => a.ext));
      expect([...receivedCount.keys()].sort((a, b) => a - b)).toEqual([
        ...arrived,
      ]);
      expect([...receivedCount.values()].every((n) => n === 1)).toBe(true);
      // Assert: 最初と最後の間の欠番は未受信として報告され、受信した TSN は未受信にならない。
      //         例外は 1 つの報告窓（32767 件）以上続く欠落で、未受信として報告しなくてよい
      const first = arrivals[0]!.ext;
      const last = arrivals.at(-1)!.ext;
      const skippable = new Set<number>();
      for (let i = 1; i < arrivals.length; i++) {
        const prev = arrivals[i - 1]!.ext;
        if (arrivals[i]!.ext - prev - 1 < 0x7fff) continue;
        for (let ext = prev + 1; ext < arrivals[i]!.ext; ext++) {
          skippable.add(ext);
        }
      }
      for (let ext = first; ext <= last; ext++) {
        if (arrived.has(ext)) expect(reportedLost.has(ext)).toBe(false);
        else if (!skippable.has(ext)) expect(reportedLost.has(ext)).toBe(true);
      }
      expect([...reportedLost].every((e) => e > first && e < last)).toBe(true);
    },
    30_000,
  );
});
