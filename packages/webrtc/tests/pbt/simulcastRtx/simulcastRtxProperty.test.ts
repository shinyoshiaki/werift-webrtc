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

/** Nearest delivered sequence number within 512 of `seq` in `step` direction. */
function hasNeighbor(delivered: Set<number>, seq: number, step: 1 | -1) {
  for (let distance = 1; distance <= 512; distance++) {
    if (delivered.has((seq + step * distance) & 0xffff)) return true;
  }
  return false;
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
      for (const rid of ["high", "low"]) {
        receiver.trackByRID[rid].onReceiveRtp.subscribe((rtp) => {
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
          deliveredBySsrc.get(ssrc)?.add(sequenceNumber);
        });
      }
      const boundRtx = new Set<number>();
      const unrepaired: string[] = [];

      for (const arrival of arrivals) {
        const delivered = deliveredBySsrc.get(arrival.stream.ssrc)!;
        // NACK に応える RTX: RTX SSRC が RID に結び付き、元の番号は未受信で、前後に受信済みがある。
        const answersNack =
          arrival.kind === "rtx" &&
          (boundRtx.has(arrival.stream.rtxSsrc) || arrival.withRrid) &&
          !delivered.has(arrival.seq) &&
          hasNeighbor(delivered, arrival.seq, -1) &&
          hasNeighbor(delivered, arrival.seq, 1);

        // Act: 到着順にパケットを router へ渡す。
        router.routeRtp(wire(arrival));
        if (arrival.kind === "rtx" && arrival.withRrid) {
          boundRtx.add(arrival.stream.rtxSsrc);
        }

        if (answersNack && !delivered.has(arrival.seq)) {
          unrepaired.push(`${arrival.stream.ssrc}:${arrival.seq}`);
        }
      }
      receiver.stop();

      // Assert: 誤った SSRC / RID / 内容のパケットは 1 つも届かない。
      expect(wrong).toEqual([]);
      // Assert: NACK に応える RTX はすべて元の媒体 SSRC に復元される。
      expect(unrepaired).toEqual([]);
    },
  );
});
