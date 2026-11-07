import { describe, expect, test } from "vitest";
import {
  createSimulcastMediaPacket,
  createSimulcastRtxPacket,
  createSimulcastRtxReceiver,
  getReceiverNack,
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
 * The judge of recovery is the receiver's NACK, not a copy of the repair
 * logic: an RTX packet arriving while `receiver.nack` requests its
 * (media SSRC, sequence number), on an RTX SSRC that told its RID, must be
 * restored. Delivery must never be wrong (SSRC, RID, timestamp, payload) and
 * a retransmission never repeats a delivered number. Streams with identical
 * bases are told apart only by SSRC; for them an RTX SSRC is exempt from the
 * moment it carried a packet while its media SSRC was not the RID's current
 * one (before the stream started or after it was replaced): no packet
 * content tells such an RTX from the current stream's.
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
 * Ground truth of the RID's current stream: a stream is current from its
 * first media packet with `rtp-stream-id` until the next stream's. Returns,
 * per RTX SSRC, the first arrival position at which it carried a packet
 * while its stream was not current (before it started or after it was
 * replaced), when that ever happened.
 */
function rtxOffCurrent(
  streams: SimulcastStream[],
  arrivals: SimulcastArrival[],
) {
  const became = new Map<SimulcastStream, number>();
  arrivals.forEach((arrival, position) => {
    if (arrival.kind === "media" && arrival.withRid) {
      if (!became.has(arrival.stream)) became.set(arrival.stream, position);
    }
  });
  const isCurrent = (stream: SimulcastStream, position: number) => {
    const from = became.get(stream);
    const next = streams.find(
      (s) => s.rid === stream.rid && s.order === stream.order + 1,
    );
    const until = next ? became.get(next) : undefined;
    return (
      from !== undefined &&
      from <= position &&
      (until === undefined || position < until)
    );
  };
  const offCurrent = new Map<number, number>();
  arrivals.forEach((arrival, position) => {
    if (arrival.kind !== "rtx" || offCurrent.has(arrival.stream.rtxSsrc)) {
      return;
    }
    if (!isCurrent(arrival.stream, position)) {
      offCurrent.set(arrival.stream.rtxSsrc, position);
    }
  });
  return offCurrent;
}

/** Whether `arrival`'s number is delivered on its stream (to see a restore). */
function retransmitted(
  deliveredBySsrc: Map<number, Set<number>>,
  arrival: SimulcastArrival,
) {
  return deliveredBySsrc.get(arrival.stream.ssrc)!.has(arrival.index);
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
      const nack = getReceiverNack(receiver);
      const streamBySsrc = new Map(streams.map((s) => [s.ssrc, s]));
      const deliveredBySsrc = new Map(
        streams.map((s) => [s.ssrc, new Set<number>()]),
      );
      const offCurrent = rtxOffCurrent(streams, arrivals);
      // 基点が同じストリームの RTX SSRC は、自分の媒体が現在でない間にパケットを運んだ時点から判別できない。
      const indistinguishable = (arrival: SimulcastArrival, at: number) =>
        arrival.kind === "rtx" &&
        arrival.stream.identicalBases &&
        (offCurrent.get(arrival.stream.rtxSsrc) ?? Infinity) <= at;
      let position = 0;
      const wrong: string[] = [];
      const duplicated: string[] = [];
      for (const rid of ["high", "low"]) {
        receiver.trackByRID[rid].onReceiveRtp.subscribe((rtp, _ext, info) => {
          const { ssrc, sequenceNumber, timestamp } = rtp.header;
          const stream = streamBySsrc.get(ssrc);
          const sent = stream?.packets.get(sequenceNumber);
          const cause = arrivals[position];
          if (
            stream?.rid !== rid ||
            sent?.timestamp !== timestamp ||
            sent.payload !== rtp.payload.toString()
          ) {
            if (!indistinguishable(cause, position)) {
              wrong.push(`${rid} ${ssrc}:${sequenceNumber}`);
            }
            return;
          }
          const index = stream.indexBySeq.get(sequenceNumber)!;
          const delivered = deliveredBySsrc.get(ssrc)!;
          // 再送は受信済みの番号を埋め直さない (重複 RTX の二重配送がない)。
          if (info?.type === "retransmission" && delivered.has(index)) {
            duplicated.push(`${ssrc}:${sequenceNumber}`);
          }
          delivered.add(index);
        });
      }
      const ridKnownRtx = new Set<number>();
      const unrepaired: string[] = [];

      for (; position < arrivals.length; position++) {
        const arrival = arrivals[position];
        // 判定基準: NACK がこの (媒体 SSRC, seq) を要求中で、RTX SSRC が RID を名乗ったことがある。
        const requested =
          arrival.kind === "rtx" &&
          (ridKnownRtx.has(arrival.stream.rtxSsrc) || arrival.withRrid) &&
          nack.lostSeqNumbersOf(arrival.stream.ssrc).includes(arrival.seq) &&
          !indistinguishable(arrival, position);
        const before = retransmitted(deliveredBySsrc, arrival);

        // Act: 到着順にパケットを router へ渡す。
        router.routeRtp(wire(arrival));
        if (arrival.kind === "rtx" && arrival.withRrid) {
          ridKnownRtx.add(arrival.stream.rtxSsrc);
        }

        if (requested && before === retransmitted(deliveredBySsrc, arrival)) {
          unrepaired.push(`${arrival.stream.ssrc}:${arrival.seq}`);
        }
      }
      // Assert: パケット駆動の経路・対応表は RID ごとの上限 (媒体 1、RTX 8、退役 8) を超えない。
      expect(Object.keys(receiver.mediaSsrcByRid).length).toBeLessThanOrEqual(
        2,
      );
      expect(Object.keys(receiver.ridByRtxSsrc).length).toBeLessThanOrEqual(
        2 * 8,
      );
      for (const retired of Object.values(receiver.retiredSsrcsByRid)) {
        expect(retired.length).toBeLessThanOrEqual(8);
      }
      expect(receiver.learnedTrackSsrcs.size).toBeLessThanOrEqual(2);
      expect(router.learnedSsrcs.size).toBeLessThanOrEqual(2 + 2 * 8);
      receiver.stop();

      // Assert: 誤った SSRC / RID / 内容のパケットは 1 つも届かない。
      expect(wrong).toEqual([]);
      // Assert: 受信済みの番号が再送として二重に届くことはない。
      expect(duplicated).toEqual([]);
      // Assert: NACK が要求している番号の RTX はすべて元の媒体 SSRC に復元される。
      expect(unrepaired).toEqual([]);
    },
  );
});
