import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { detectLeak } from "../../memleak/heapUtils";
import { NegotiationCase } from "../../negotiation/harness/negotiationCase";
import { CLOSE_TIMING_OPERATIONS } from "../../negotiation/harness/negotiationTransactionUtils";
import {
  type Cycle,
  closedHandshakeLeaks,
  closedOperationLeaks,
  closedSceneLeaks,
  closedSilentTurnLeaks,
  closedTurnGatherLeaks,
  composeCycle,
  cycleGrowth,
  drawCycle,
  heapSamples,
  type LeakScene,
  leakSupport,
  runCycles,
  useLocalStunServer,
} from "./leakProbe";
import { CLOSED_SCENES, LEAK_CYCLES } from "./scenes";

/**
 * Leak property of the negotiation transaction, with deterministic verdicts
 * (no heap slope in CI):
 *
 * - P1 (L1 retention, L2 OS resources): after any scene of the model
 *   property (`model/generator.ts`, wire rewrites included) and
 *   `expectSessionContinues`, optionally ended by a `close()` that
 *   interrupts an operation, closing both peers leaves no object the scene
 *   created reachable (`WeakRef`s cleared after GC) and no socket, timer or
 *   immediate beyond the count before the scene.
 * - P2 (L3 growth inside a session): repeating one cycle of operations from
 *   stable back to stable on a connected session keeps every metric of
 *   `leakFootprint` at its value after the second repetition (plus the
 *   growth the cycle declares); bounded metrics stay within their bound.
 * - P3 (heap slope, statistical): `WERIFT_NEGOTIATION_LEAK_HEAP=1` repeats a
 *   P2 cycle `WERIFT_NEGOTIATION_LEAK_HEAP_CYCLES` (default 200) times and
 *   judges heapUsed with `detectLeak` of tests/memleak. Not run in CI.
 *
 * Fixed scenes and cycles are in `leak/scenes.ts`. Random scenes: CI runs
 * `WERIFT_NEGOTIATION_LEAK_SEEDS` (default 2) seeds from
 * `WERIFT_NEGOTIATION_LEAK_SEED` (default 1) with
 * `WERIFT_NEGOTIATION_LEAK_STEPS` (default 8) operations, and P2 cycles
 * repeated `WERIFT_NEGOTIATION_LEAK_CYCLES` (default 4) times. A failure
 * prints the seed, the scene or cycle and, unless
 * `WERIFT_NEGOTIATION_LEAK_SHRINK=0`, the smallest failing one found.
 *
 * Each test runs without retry: a leak must not pass on a second attempt.
 *
 * Peers that name no ICE servers query a STUN server in this process
 * (`useLocalStunServer`), so no verdict depends on the network. Besides the
 * continuation and the interrupts, a scene may end closed as it is (`asIs`:
 * a pending offer or pranswer and its proposal's transports included).
 * Harness references that would look like leaks are released or bounded:
 * the continuation records (`releaseContinuationRecords`), the operation log
 * (last 40), and the case and its oracles, which stay inside the function
 * that runs a scene. A surplus `Timeout` is reported with the creation stack
 * of every live timer (`live timer created at:`).
 *
 * Known flakes of the model property that predate this property (not leak
 * findings): leak seed 57 (10 steps) sometimes ends with "added DataChannel
 * did not reach the peer" (both SCTP associations stay in their handshake
 * over a connected DTLS transport); model seed 275 (10 steps) sometimes ends
 * with "the transport did not settle", also when replayed alone. Both fail
 * the same way before the leak property was added.
 *
 * `npm run leak:verify` (`tools/leak-verify/run.sh`) repeats this file and
 * injects artificial leaks to show each is detected.
 */
const env = process.env;
const seedCount = Number(env.WERIFT_NEGOTIATION_LEAK_SEEDS ?? 2);
const stepCount = Number(env.WERIFT_NEGOTIATION_LEAK_STEPS ?? 8);
const firstSeed = Number(env.WERIFT_NEGOTIATION_LEAK_SEED ?? 1);
const cycleCount = Math.max(3, Number(env.WERIFT_NEGOTIATION_LEAK_CYCLES ?? 4));
const shrink = env.WERIFT_NEGOTIATION_LEAK_SHRINK !== "0";
const heap = env.WERIFT_NEGOTIATION_LEAK_HEAP === "1";
const heapCycles = Number(env.WERIFT_NEGOTIATION_LEAK_HEAP_CYCLES ?? 200);
const seeds = [...Array(seedCount).keys()].map((i) => firstSeed + i);
const replay = (seed: number) =>
  `WERIFT_NEGOTIATION_LEAK_SEED=${seed} WERIFT_NEGOTIATION_LEAK_SEEDS=1 WERIFT_NEGOTIATION_LEAK_STEPS=${stepCount} WERIFT_NEGOTIATION_LEAK_CYCLES=${cycleCount}`;
const options = (timeout: number) => ({ retry: 0, timeout });
const unsupported = leakSupport();
if (unsupported) {
  console.warn(`negotiation leak property skipped: ${unsupported}`);
}

/** Shrink a leaking scene: drop its ending (interrupt or close as it is), then one operation at a time, while it still leaks. */
async function shrinkClosedScene(scene: LeakScene, budget: number) {
  const deadline = Date.now() + budget;
  const leaks = async (candidate: LeakScene) => {
    const result = await closedSceneLeaks("shrinking", {
      scene: candidate,
      lenient: true,
    });
    return result.problems.length > 0;
  };
  let small = scene;
  if (small.interrupt || small.asIs) {
    const { interrupt: _, asIs: __, ...rest } = small;
    if (await leaks(rest)) small = rest;
  }
  for (let i = small.ops.length - 1; i >= 0 && Date.now() < deadline; i--) {
    const candidate = { ...small, ops: small.ops.filter((_, j) => j !== i) };
    if (await leaks(candidate)) small = candidate;
  }
  return small;
}

/** Run a cycle `cycleCount` times on one session; returns the growth problems. */
async function cycleProblems(
  name: string,
  cycle: Cycle,
  repetitions = cycleCount,
) {
  const c = new NegotiationCase(name, { ref: "property: leak", traffic: true });
  let problems: string[] = [];
  await c.run(async () => {
    const run = await runCycles(c, cycle, repetitions);
    problems = cycleGrowth(run);
    // 計測の後で、通信と継続確認を通す (計測には含めない)。
    await c.end();
  });
  return problems;
}

/** Shrink a growing cycle: drop one template at a time while it still grows. */
async function shrinkCycle(cycle: Cycle, budget: number) {
  const deadline = Date.now() + budget;
  let templates = cycle.templates;
  for (let i = templates.length - 1; i >= 0 && Date.now() < deadline; i--) {
    if (templates.length === 1) break;
    const candidate = templates.filter((_, j) => j !== i);
    const problems = await cycleProblems("shrinking", composeCycle(candidate));
    if (problems.length) templates = candidate;
  }
  return templates;
}

const describeLeak = unsupported ? describe.skip : describe;

describeLeak("negotiation leak property", () => {
  // Arrange: ICE server を指定しない peer は、公開の STUN server の代わりにこの process の
  // STUN server を使う (判定がネットワークに左右されない)。
  let stopStun: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    stopStun = await useLocalStunServer();
  });
  afterAll(async () => {
    await stopStun?.();
  });

  describe("P1: closing after any operations leaves nothing behind", () => {
    for (const scene of CLOSED_SCENES) {
      test(`fixed: ${scene.name}`, options(60_000), async () => {
        // Arrange / Act: 固定シーンを実行し、継続確認と割り込みの close の後に両 peer を閉じる。
        const result = await closedSceneLeaks(scene.name, { scene });
        // Assert: シーン自体 (invariant・通信・オラクル) が通る。
        expect(result.error, "the scene failed").toBeUndefined();
        // Assert: GC の後に生成物が残らず、OS リソースも開始前の数に戻る。
        expect(result.problems, `${scene.ref}`).toEqual([]);
      });
    }

    test(
      "fixed: closing while a DTLS handshake waits for its peer leaves no retransmission",
      options(30_000),
      async () => {
        // Arrange / Act: DTLS server の開始を止めて client に最初の flight を再送させ、その間に両 peer を閉じる。
        const problems = await closedHandshakeLeaks();
        // Assert: flight の再送 timer も、それが参照する transport と PeerConnection も残らない。
        expect(
          problems,
          "origin: a DTLS flight kept retransmitting (~30 s) after its transport stopped",
        ).toEqual([]);
      },
    );

    for (const wait of ["macrotask", 5, 50] as const) {
      test(
        `fixed: closing ${wait} after a TURN gathering started releases the client's sockets and timers`,
        options(30_000),
        async () => {
          // Arrange / Act: relay だけで集める peer を、TURN allocation の途中か完了後に閉じる。
          const problems = await closedTurnGatherLeaks(wait);
          // Assert: client の socket・refresh timer・オブジェクトが残らない (サーバーの relay socket は除く)。
          expect(problems).toEqual([]);
        },
      );
    }

    test(
      "fixed: closing while a TURN allocation waits on a server that never answers releases it at once",
      options(30_000),
      async () => {
        // Arrange / Act: 応答しない TURN server への allocation の途中で閉じる。
        const problems = await closedSilentTurnLeaks();
        // Assert: allocation の timeout を待たずに、client の socket と再送 timer と PeerConnection が解放される。
        expect(
          problems,
          "origin: a TURN allocation close overtook kept its socket and retransmissions until it timed out",
        ).toEqual([]);
      },
    );

    for (const operation of CLOSE_TIMING_OPERATIONS) {
      for (const ticks of [0, 2, "macrotask"] as const) {
        test(
          `close timing: ${operation} closed after ${ticks}`,
          options(30_000),
          async () => {
            // Arrange / Act: 操作の直前の状態を用意し、操作を始めて ticks 後に close() で追い越し、両 peer を閉じる。
            const problems = await closedOperationLeaks(operation, ticks);
            // Assert: PeerConnection と生成物が解放され、socket と timer が残らない。
            expect(problems).toEqual([]);
          },
        );
      }
    }

    for (const seed of seeds) {
      test(
        `seed ${seed} (replay: ${replay(seed)})`,
        options(shrink ? 300_000 : 60_000),
        async () => {
          // Arrange / Act: seed から開始状態・操作列・割り込みの close を引いて実行し、両 peer を閉じる。
          const result = await closedSceneLeaks(`seed ${seed}`, {
            seed,
            steps: stepCount,
          });
          const text = JSON.stringify(result.scene);
          // Assert: シーン自体が通る (失敗はモデル property と同じ不具合)。
          if (result.error) {
            throw new Error(
              `seed ${seed} scene ${text}\n${result.error.message}`,
              {
                cause: result.error,
              },
            );
          }
          // Assert: 生成物が解放され、OS リソースが残らない。失敗したら縮小したシーンを出す。
          if (result.problems.length) {
            const small = shrink
              ? JSON.stringify(await shrinkClosedScene(result.scene, 180_000))
              : "(shrinking disabled)";
            expect.fail(
              [
                `seed ${seed} leaked after close`,
                ...result.problems,
                `scene: ${text}`,
                `smallest leaking scene: ${small}`,
              ].join("\n"),
            );
          }
        },
      );
    }
  });

  describe("P2: repeating a cycle keeps the session's state from growing", () => {
    for (const fixed of LEAK_CYCLES) {
      test(`fixed: ${fixed.name}`, options(120_000), async () => {
        // Arrange / Act: 接続済みの session で同じ周期を繰り返し、毎回の後に大きさを記録する。
        const problems = await cycleProblems(
          fixed.name,
          composeCycle(fixed.templates),
        );
        // Assert: 2 回目以降、各指標は 2 回目の後の値 (と宣言した増分) のまま。
        expect(problems, fixed.ref).toEqual([]);
      });
    }

    for (const seed of seeds) {
      test(
        `cycle seed ${seed} (replay: ${replay(seed)})`,
        options(shrink ? 300_000 : 120_000),
        async () => {
          // Arrange / Act: seed から stable に戻る周期を引き、同じ操作列を繰り返す。
          const cycle = drawCycle(seed);
          const problems = await cycleProblems(`cycle seed ${seed}`, cycle);
          // Assert: 状態が増え続けない。失敗したら縮小した周期を出す。
          if (problems.length) {
            const small = shrink
              ? JSON.stringify(await shrinkCycle(cycle, 180_000))
              : "(shrinking disabled)";
            expect.fail(
              [
                `cycle seed ${seed} grew: ${JSON.stringify(cycle.templates)}`,
                ...problems,
                `ops: ${JSON.stringify(cycle.ops)}`,
                `smallest growing cycle: ${small}`,
              ].join("\n"),
            );
          }
        },
      );
    }
  });

  describe.runIf(heap)("P3: the heap does not grow over many cycles", () => {
    for (const seed of seeds) {
      test(
        `heap seed ${seed} (replay: ${replay(seed)} WERIFT_NEGOTIATION_LEAK_HEAP=1)`,
        options(1_800_000),
        async () => {
          // Arrange / Act: P2 の周期を多数回繰り返し、各回の後に GC してから heapUsed を記録する。
          const cycle = drawCycle(seed);
          const c = new NegotiationCase(`heap seed ${seed}`, {
            ref: "property: leak P3",
            // invariant は候補の履歴を保持するので、各操作の後には検査しない。
            explicitInvariants: true,
          });
          let samples: Awaited<ReturnType<typeof heapSamples>> = [];
          await c.run(async () => {
            samples = await heapSamples(c, cycle, heapCycles);
            await c.end();
          });
          // Assert: ウォームアップ後の heapUsed の傾きとマージンが閾値に収まる (tests/memleak と同じ判定)。
          const verdict = detectLeak(samples, {
            warmup: Math.min(20, Math.floor(heapCycles / 5)),
            slopeThresholdBytes: 16 * 1024,
            marginRatio: 0.3,
          });
          expect(
            verdict.leaked,
            `${JSON.stringify(cycle.templates)}: ${verdict.reason}`,
          ).toBe(false);
        },
      );
    }
  });
});
