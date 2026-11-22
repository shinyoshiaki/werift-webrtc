import { type SeededRandom, seededRandom } from "../../../../pbt/src";

/**
 * Generator of failover thresholds (`IceOptions.failover`) inside the ranges
 * the timing properties reason about: `receivingTimeout` 1–4 s (not below the
 * 900 ms weak interval), `receivingSwitchingDelay` 0–2 s,
 * `unwritableMinChecks` 1–6, `unwritableTimeout` 0–6 s.
 */
export function drawFailoverThresholds(random: SeededRandom) {
  return {
    receivingTimeout: random.int(1_000, 4_001),
    receivingSwitchingDelay: random.int(0, 2_001),
    unwritableMinChecks: random.int(1, 7),
    unwritableTimeout: random.int(0, 6_001),
  };
}

/**
 * Generator of the burst property: random thresholds, nomination mode, the
 * direction of the break (`both`: nothing arrives; `outbound`: the peer's data
 * still arrives every 200 ms) and, for `both`, how long the selected path is
 * cut, drawn around the rules' boundaries:
 * - `beforeCheck`: shorter than `receivingTimeout` (no check goes unanswered);
 * - `withinDelay`: the first check is counted unanswered (the cut outlasts
 *   `receivingTimeout` + the 1 s response deadline), but the cut ends well
 *   before `receivingTimeout` + `receivingSwitchingDelay` (a delay of 3–4 s,
 *   and an unwritable rule that cannot hold: 6 checks);
 * - `long`: longer than the receiving rule needs (`receivingTimeout` +
 *   delay + 2.2 s and up to 8 s more);
 * - `any`: 0.2–15 s.
 */
export function drawFailoverBurstCase(seed: number) {
  const random = seededRandom(seed);
  const thresholds = drawFailoverThresholds(random);
  const kind = random.pick([
    "beforeCheck",
    "withinDelay",
    "long",
    "any",
  ] as const);
  const rt = thresholds.receivingTimeout;
  let burstMs: number;
  if (kind === "withinDelay") {
    thresholds.receivingSwitchingDelay = random.int(3_000, 4_001);
    thresholds.unwritableMinChecks = 6;
    burstMs = random.int(
      rt + 1_000,
      rt + thresholds.receivingSwitchingDelay - 1_200,
    );
  } else if (kind === "beforeCheck") {
    burstMs = random.int(200, rt - 200);
  } else if (kind === "long") {
    const needed = rt + thresholds.receivingSwitchingDelay + 2_200;
    burstMs = random.int(needed, needed + 8_000);
  } else {
    burstMs = random.int(200, 15_000);
  }
  return {
    thresholds,
    renomination: random.chance(0.5),
    direction: random.chance(0.75) ? ("both" as const) : ("outbound" as const),
    kind,
    burstMs,
    random,
  };
}
