import { describe } from "vitest";

import {
  describeCases,
  negotiationCase,
} from "../negotiation/harness/negotiationCase";
import { runTrafficEpisode } from "./trafficPropertyUtils";
import { trafficScenes } from "./trafficScenes";

/**
 * Traffic property: every stream and DataChannel the peers negotiated
 * carries traffic after every operation. The case harness checks it
 * (`c.expectTraffic()`) after each description operation and after the
 * scene, next to the invariants of both peers; every scene ends with
 * `expectSessionContinues`.
 *
 * - Fixed scenes (`trafficScenes.ts`): the deterministic cases whose verdict
 *   included real traffic and that need no special environment, with their
 *   own expectations, under their original names.
 * - Random scenes (`trafficPropertyUtils.ts`): from a connected session or
 *   two unnegotiated peers, operations drawn by a seed (tracks, recvonly
 *   transceivers, DataChannels, direction, stop, track attach, ICE restart,
 *   offer / BUNDLE split offer / replacement offer, pranswer, answer,
 *   rollback).
 *
 * CI runs `WERIFT_NEGOTIATION_TRAFFIC_SEEDS` (default 4) seeds of
 * `WERIFT_NEGOTIATION_TRAFFIC_STEPS` (default 8) operations from
 * `WERIFT_NEGOTIATION_TRAFFIC_SEED` (default 1); a failure prints the seed
 * and the operations, and the printed command replays it.
 */
const seedCount = Number(process.env.WERIFT_NEGOTIATION_TRAFFIC_SEEDS ?? 4);
const stepCount = Number(process.env.WERIFT_NEGOTIATION_TRAFFIC_STEPS ?? 8);
const firstSeed = Number(process.env.WERIFT_NEGOTIATION_TRAFFIC_SEED ?? 1);
const seeds = [...Array(seedCount).keys()].map((i) => ({
  seed: firstSeed + i,
}));

describeCases(
  "negotiation traffic property: every negotiated stream and DataChannel carries traffic after every operation",
  () => {
    describe("fixed scenes", trafficScenes);

    negotiationCase.for(seeds)(
      `seed $seed (replay: WERIFT_NEGOTIATION_TRAFFIC_SEED=$seed WERIFT_NEGOTIATION_TRAFFIC_SEEDS=1 WERIFT_NEGOTIATION_TRAFFIC_STEPS=${stepCount})`,
      { ref: "2.1-5 2.2-1 5-4; property: traffic", traffic: true },
      async (c, { seed }) => {
        // Arrange / Act: seed から開始状態と操作列を引き、順に実行する。
        // Assert: 各記述操作の後と最後に、交渉済みの全 stream と DataChannel の通信を検査する (ハーネス)。
        await runTrafficEpisode(c, seed, stepCount);
      },
    );
  },
);
