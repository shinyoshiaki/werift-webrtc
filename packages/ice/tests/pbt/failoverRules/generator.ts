import { seededRandom } from "../../../../pbt/src";
import type { PairLiveness } from "../../../src/failover";
import { drawFailoverThresholds } from "../failoverBurst/generator";

/**
 * A pair's liveness, a time and thresholds. `missedSince` is set exactly when
 * `unanswered` > 0 (as `FailoverMonitor.unanswered` does), at any time from
 * shortly before the last reception to `now`, so the draw covers a pair
 * receiving, one whose silence waits for the unanswered check, one inside
 * the hold and one past it.
 */
export function drawLivenessCase(seed: number) {
  const random = seededRandom(seed);
  const since = random.int(0, 10_000);
  const lastResponse = random.chance(0.8)
    ? since + random.int(0, 10_000)
    : undefined;
  const lastReceived = (lastResponse ?? since) + random.int(0, 5_000);
  const now = lastReceived + random.int(0, 12_000);
  const unanswered = random.int(0, 8);
  const liveness: PairLiveness = {
    since,
    lastResponse,
    lastReceived,
    unanswered,
    missedSince:
      unanswered > 0
        ? random.int(Math.max(since, lastReceived - 2_000), now + 1)
        : undefined,
    responses: random.int(0, 5),
    consecutive: random.int(0, 3),
    broken: random.chance(0.1),
  };
  const later = now + random.int(0, 5_000);
  const thresholds = drawFailoverThresholds(random);
  return { liveness, now, later, thresholds, random };
}
