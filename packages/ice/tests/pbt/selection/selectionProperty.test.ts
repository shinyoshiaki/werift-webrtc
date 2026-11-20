import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { type CandidatePair, CandidatePairState } from "../../../src";
import { createNominationHarness, type ScriptedRequest } from "../../utils";

/**
 * Selection model property (controlling, semi-aggressive nomination and
 * renomination): for a random sequence of candidates, checks, replies and
 * elapsed time, the selection is always the best valid pair the model
 * allows, nominated as the mode says.
 *
 * CI runs `WERIFT_ICE_SELECTION_SEEDS` (default 40) seeds of
 * `WERIFT_ICE_SELECTION_STEPS` (default 30) operations from
 * `WERIFT_ICE_SELECTION_SEED` (default 1), each in both modes. A failing
 * title prints the replay environment.
 */
const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;
/** Captured before the fake timers replace it. */
const realSetTimeout = setTimeout;
/** Real `setTimeout`: the paced outranking checks wait on `node:timers/promises`, which fake timers do not advance. */
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

describe(
  "semi-aggressive nomination / renomination (controlling): model property",
  propertyOptions(),
  () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const PRIORITIES = [LOW, MID, 300_000_000, HIGH];
    const { seeds, steps, replay, title } = propertySeeds(
      "WERIFT_ICE_SELECTION",
      {
        seeds: 40,
        steps: 30,
      },
    );

    test.each(
      seeds.flatMap((seed) =>
        (["semi-aggressive", "renomination"] as const).map((mode) => ({
          seed,
          mode,
        })),
      ),
    )(title("$mode"), async ({ seed, mode }) => {
      // Arrange: seed から候補の追加・check の開始・応答 (成功 / 失敗)・時間の経過の列を決める。
      const random = seededRandom(seed);
      const renomination = mode === "renomination";
      const h = createNominationHarness({
        nomination: "semi-aggressive",
        renomination,
        nominationReply: () => "hold",
      });
      const pairs: { pair: CandidatePair; priority: number }[] = [];
      const failures = new Map<CandidatePair, number>();
      const trace: string[] = [];
      let lastValue = 0;
      let processed = 0;
      /** Requests of the checks a peer's check triggered (any pair, also after the selection). */
      const triggered = new Set<number>();
      const why = (what: string) =>
        `${what} (${replay(seed)}; ${trace.join(", ")})`;
      const priorityOf = (pair: CandidatePair) =>
        pairs.find((p) => p.pair === pair)!.priority;
      const pairAt = (port: number) =>
        pairs.find((p) => p.pair.remoteAddr[1] === port)!.pair;
      const selected = () => h.connection.nominated;
      const outranksSelection = (pair: CandidatePair) =>
        !selected() || priorityOf(pair) > priorityOf(selected()!);
      const isSameSocketBackup = (pair: CandidatePair) => {
        const current = selected();
        return (
          !!current && pair !== current && pair.protocol === current.protocol
        );
      };
      const pending = () => h.requests().filter((request) => !request.done);
      /** Pairs with no request in flight. */
      const idle = () =>
        pairs.filter(
          (p) => !pending().some((r) => r.addr[1] === p.pair.remoteAddr[1]),
        );

      /** Check the requests sent since the last step and the state they left. */
      const observe = (before: CandidatePair | undefined) => {
        const after = selected();
        for (; processed < h.requests().length; processed++) {
          const request = h.requests()[processed];
          const keys = request.message.attributesKeys;
          const pair = pairAt(request.addr[1]);
          trace.push(
            `sent:${priorityOf(pair)}${keys.includes("NOMINATION") ? "/N" : ""}`,
          );
          if (renomination) {
            // Assert: renomination は USE-CANDIDATE を使わず、NOMINATION の値は増え続ける。
            expect(keys, why("USE-CANDIDATE with renomination")).not.toContain(
              "USE-CANDIDATE",
            );
            if (keys.includes("NOMINATION")) {
              const value = request.message.getAttributeValue("NOMINATION");
              expect(value, why("NOMINATION is not the next value")).toBe(
                lastValue + 1,
              );
              lastValue = value;
            }
          } else if (triggered.has(processed)) {
            // Assert: semi-aggressive の check は、未選択の間と選択より上位の pair にだけ USE-CANDIDATE を運ぶ。
            expect(
              request.nominate,
              why("USE-CANDIDATE on a triggered check"),
            ).toBe(outranksSelection(pair));
          } else if (
            isSameSocketBackup(pair) &&
            priorityOf(pair) < priorityOf(selected()!) &&
            !keys.includes("USE-CANDIDATE") &&
            !keys.includes("NOMINATION")
          ) {
            // Assert: 同じ socket の下位ペアは nomination せず backup として監視する。
            expect(
              request.nominate,
              why("a backup check carries nomination"),
            ).toBe(false);
          } else {
            // Assert: 自分から送る check は (未選択か選択より上位なので) すべて USE-CANDIDATE を運ぶ。
            expect(request.nominate, why("a check without USE-CANDIDATE")).toBe(
              true,
            );
          }
          // Assert: 選択後に自分から送る check と指名は、選択より上位の pair にだけ送る。
          if (
            after &&
            pair !== after &&
            !triggered.has(processed) &&
            (keys.includes("USE-CANDIDATE") || keys.includes("NOMINATION"))
          ) {
            expect(
              outranksSelection(pair),
              why("a request to a pair below the selection"),
            ).toBe(true);
          }
        }
        // Assert: 選択は上位の pair にしか移らない。
        if (before && after !== before) {
          expect(
            priorityOf(after!) > priorityOf(before),
            why("the selection moved down"),
          ).toBe(true);
        }
        // Assert: 選択より上位の pair は、失敗させた応答なしには FAILED にならない (8.1.2 の掃除は下位だけ)。
        for (const { pair } of pairs) {
          if (
            pair.state === CandidatePairState.FAILED &&
            outranksSelection(pair)
          ) {
            expect(
              failures.has(pair),
              why("a higher pair failed without a failure"),
            ).toBe(true);
          }
        }
        // Assert: renomination では NOMINATION の指名は同時に 1 つだけ。
        if (renomination) {
          const inFlight = pending().filter((request) =>
            request.message.attributesKeys.includes("NOMINATION"),
          );
          expect(
            inFlight.length,
            why("several NOMINATION checks in flight"),
          ).toBeLessThanOrEqual(1);
        }
      };

      try {
        for (let step = 0; step < steps; step++) {
          const before = selected();
          let answered:
            | { request: ScriptedRequest; pair: CandidatePair }
            | undefined;
          const waiting = pairs.filter(
            (p) => p.pair.state === CandidatePairState.WAITING && !before,
          );
          const answerable = pending();
          const actions = [
            ...(pairs.length < PRIORITIES.length ? ["add", "add"] : []),
            ...(waiting.length > 0 ? ["check"] : []),
            ...(answerable.length > 0 ? ["success", "success", "failure"] : []),
            ...(before && idle().length > 0 ? ["triggered"] : []),
            "advance",
          ];
          const action = random.pick(actions);

          // Act: seed の操作を 1 つ行う。
          if (action === "add") {
            const priority = random.pick(
              PRIORITIES.filter((p) => !pairs.some((q) => q.priority === p)),
            );
            trace.push(`add:${priority}`);
            const pair = await h.addRemote(priority);
            // Assert: 選択後も、同じ socket の別リモートへの下位候補は backup pair になる。
            if (before && priority < priorityOf(before)) {
              expect(
                pair,
                why("a same-socket backup pair was not formed"),
              ).toBeDefined();
              expect(pair!.protocol).toBe(before.protocol);
            }
            if (pair) {
              pairs.push({ pair, priority });
              // 選択前の check の開始はスケジューラ相当 (すぐに、または後の "check" で)。
              if (!before && random.chance(0.6)) h.check(pair);
            }
          } else if (action === "triggered") {
            // 相手の check が起こす triggered check (選択より下位の pair にも起きる)。
            const { pair, priority } = random.pick(idle());
            trace.push(`triggered:${priority}`);
            triggered.add(h.requests().length);
            h.check(pair);
          } else if (action === "check") {
            const { pair, priority } = random.pick(waiting);
            trace.push(`check:${priority}`);
            h.check(pair);
          } else if (action === "success" || action === "failure") {
            const request = random.pick(answerable);
            const pair = pairAt(request.addr[1]);
            const failed =
              action === "failure" && (failures.get(pair) ?? 0) < 2;
            trace.push(`${failed ? "failure" : "success"}:${priorityOf(pair)}`);
            if (failed) failures.set(pair, (failures.get(pair) ?? 0) + 1);
            request.release(failed ? "failure" : "success");
            if (!failed) answered = { request, pair };
          } else {
            const ms = random.pick([0, 500, 1000, 2000, 5000, 16_000]);
            trace.push(`advance:${ms}`);
            await vi.advanceTimersByTimeAsync(ms);
          }
          await vi.advanceTimersByTimeAsync(0);
          observe(before);

          // Assert: 指名を運ぶ check (semi-aggressive は USE-CANDIDATE、renomination は NOMINATION) が成功すると、未選択か上位ならすぐにその pair を選択する。
          const carried =
            answered &&
            (renomination
              ? answered.request.message.attributesKeys.includes("NOMINATION")
              : answered.request.nominate);
          if (
            answered &&
            carried &&
            (!before || priorityOf(answered.pair) > priorityOf(before))
          ) {
            expect(selected(), why("not selected at once")).toBe(answered.pair);
          }
          // Assert: renomination では、選択より上位の valid pair があれば NOMINATION の check を出している。
          if (renomination) {
            const better = pairs.some(
              (p) =>
                p.pair.state === CandidatePairState.SUCCEEDED &&
                outranksSelection(p.pair),
            );
            const inFlight = pending().some((r) =>
              r.message.attributesKeys.includes("NOMINATION"),
            );
            if (better)
              expect(
                inFlight,
                why("no NOMINATION for a better valid pair"),
              ).toBe(true);
          }
        }

        // Act: 以降の check と指名にすべて成功で応答し、再 check の時間を経過させる。
        for (let round = 0; round < 40; round++) {
          const before = selected();
          if (pending().length > 0) {
            for (const request of pending()) request.release("success");
          } else if (
            pairs.some((p) => p.pair.state === CandidatePairState.WAITING)
          ) {
            if (!before) {
              for (const p of pairs)
                if (p.pair.state === CandidatePairState.WAITING)
                  h.check(p.pair);
            } else {
              await realDelay(25);
            }
          } else {
            const sent = h.requests().length;
            await vi.advanceTimersByTimeAsync(20_000);
            if (h.requests().length === sent) break;
          }
          await vi.advanceTimersByTimeAsync(0);
          observe(before);
        }

        // Assert: 選択があれば最終的に最上位の pair が選択される (renomination は最後に送った値で)。
        // 選択がないのは、選択前にすべての pair が失敗したときだけ (再 check は選択後に働く)。
        const top = [...pairs].sort((a, b) => b.priority - a.priority)[0]?.pair;
        if (selected()) {
          expect(selected(), why("the top pair is not selected")).toBe(top);
          if (renomination) {
            expect(top.nomination, why("final NOMINATION value")).toBe(
              lastValue,
            );
          }
        } else {
          expect(
            pairs.every((p) => p.pair.state === CandidatePairState.FAILED),
            why("nothing selected while a pair can still succeed"),
          ).toBe(true);
        }
      } finally {
        await h.connection.close();
      }
    });
  },
);
