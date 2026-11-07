import { describe, expect, test } from "vitest";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
} from "../../media/rtpReceiverTestUtils";
import { seededRandom } from "../shared/random";
import { propertySeeds } from "../shared/seeds";
import {
  randomSimulcastRtxTraffic,
  type SimulcastArrival,
  type SimulcastStream,
} from "./generator";

/**
 * Simulcast RTX property test: RID-based RTX without `ssrc-group:FID`
 * (`RTCRtpReceiver.mediaSsrcOfRtx`) for any traffic a seed draws
 * (`simulcastRtx/generator.ts`): media SSRC changes of a RID without
 * renegotiation, loss, reordering, late originals, duplicate and unsolicited
 * RTX, and RID extensions that stop after the first packets.
 *
 * CI runs `WERIFT_SIMULCAST_RTX_SEEDS` (default 24) seeds per property from
 * `WERIFT_SIMULCAST_RTX_SEED` (default 1); `WERIFT_SIMULCAST_RTX_STEPS`
 * (default 300) is the number of packets per media SSRC. A failing title
 * prints the replay environment.
 */
const { seeds, steps, replay } = propertySeeds("WERIFT_SIMULCAST_RTX", {
  seeds: 24,
  steps: 300,
});
const cases = seeds.map((seed) => ({ seed }));
const title = (claim: string) =>
  `${claim}: seed $seed (replay: ${replay("$seed")})`;

/** The original RTP packet of `stream` with sequence number `seq`. */
function original(stream: SimulcastStream, seq: number, withRid: boolean) {
  const { timestamp, payload } = stream.packets.get(seq)!;
  return createSimulcastMediaPacket({
    ssrc: stream.ssrc,
    sequenceNumber: seq,
    rid: withRid ? stream.rid : undefined,
    mid: withRid ? "0" : null,
    timestamp,
    payload: Buffer.from(payload),
  });
}

function wire(arrival: SimulcastArrival) {
  if (arrival.kind === "media") {
    return original(arrival.stream, arrival.seq, arrival.withRid);
  }
  return createSimulcastRtxPacket(
    original(arrival.stream, arrival.seq, false),
    {
      rtxSsrc: arrival.stream.rtxSsrc,
      rtxSequenceNumber: arrival.rtxSeq,
      rrid: arrival.withRrid ? arrival.stream.rid : undefined,
      mid: arrival.withRrid ? "0" : null,
    },
  );
}

/**
 * Whether the receiver can know `index` is a hole worth repairing: delivered
 * packets on both sides, the newest less than 1024 (its history) ahead, and
 * the one before the hole still inside that history.
 */
function repairable(delivered: Set<number>, index: number) {
  if (delivered.has(index)) return false;
  let lo: number | undefined;
  let newest: number | undefined;
  for (const d of delivered) {
    if (d < index && (lo === undefined || d > lo)) lo = d;
    if (newest === undefined || d > newest) newest = d;
  }
  return (
    lo !== undefined &&
    newest !== undefined &&
    newest > index &&
    newest - lo < 1024
  );
}

describe("simulcast RTX property", () => {
  test.each(cases)(
    title(
      "復元パケットは常に元の SSRC / seq / timestamp / payload で元の RID の track に届き、NACK に応える RTX は必ず復元される",
    ),
    ({ seed }) => {
      // Arrange
      const rng = seededRandom(seed);
      const { streams, arrivals } = randomSimulcastRtxTraffic(rng, steps);
      const { router, receiver } = createSimulcastRtxReceiver();
      const streamBySsrc = new Map(streams.map((s) => [s.ssrc, s]));
      const deliveredBySsrc = new Map(
        streams.map((s) => [s.ssrc, new Set<number>()]),
      );
      const wrong: string[] = [];
      const duplicated: string[] = [];
      for (const rid of ["high", "low"]) {
        receiver.trackByRID[rid].onReceiveRtp.subscribe((rtp, _ext, info) => {
          const { ssrc, sequenceNumber, timestamp } = rtp.header;
          const stream = streamBySsrc.get(ssrc);
          const sent = stream?.packets.get(sequenceNumber);
          if (
            stream?.rid !== rid ||
            sent?.timestamp !== timestamp ||
            sent.payload !== rtp.payload.toString()
          ) {
            wrong.push(`${rid} ${ssrc}:${sequenceNumber}`);
          }
          const index = stream?.indexBySeq.get(sequenceNumber);
          if (index === undefined) return;
          const delivered = deliveredBySsrc.get(ssrc)!;
          // 再送は受信済みの番号を埋め直さない (重複 RTX の二重配送がない)。
          if (info?.type === "retransmission" && delivered.has(index)) {
            duplicated.push(`${ssrc}:${sequenceNumber}`);
          }
          delivered.add(index);
        });
      }
      const boundRtx = new Set<number>();
      const unrepaired: string[] = [];

      for (const arrival of arrivals) {
        const delivered = deliveredBySsrc.get(arrival.stream.ssrc)!;
        // NACK に応える RTX: RTX SSRC が RID に結び付き、元の番号は受信側が知る範囲の欠落。
        const answersNack =
          arrival.kind === "rtx" &&
          (boundRtx.has(arrival.stream.rtxSsrc) || arrival.withRrid) &&
          repairable(delivered, arrival.index);

        // Act: 到着順にパケットを router へ渡す。
        router.routeRtp(wire(arrival));
        if (arrival.kind === "rtx" && arrival.withRrid) {
          boundRtx.add(arrival.stream.rtxSsrc);
        }

        if (answersNack && !delivered.has(arrival.index)) {
          unrepaired.push(`${arrival.stream.ssrc}:${arrival.seq}`);
        }
      }
      // Assert: パケット駆動の経路・対応表は RID ごとの上限 (媒体 4 + RTX 4) を超えない。
      expect(router.learnedSsrcs.size).toBeLessThanOrEqual(2 * 8);
      expect(receiver.learnedTrackSsrcs.size).toBeLessThanOrEqual(2 * 4);
      expect(Object.keys(receiver.ridByRtxSsrc).length).toBeLessThanOrEqual(
        2 * 4,
      );
      receiver.stop();

      // Assert: 誤った SSRC / RID / 内容のパケットは 1 つも届かない。
      expect(wrong).toEqual([]);
      // Assert: 受信済みの番号が再送として二重に届くことはない。
      expect(duplicated).toEqual([]);
      // Assert: NACK に応える RTX はすべて元の媒体 SSRC に復元される。
      expect(unrepaired).toEqual([]);
    },
  );
});
