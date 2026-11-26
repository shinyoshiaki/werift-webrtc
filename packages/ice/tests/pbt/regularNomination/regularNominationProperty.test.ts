import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import { type CandidatePair, CandidatePairState } from "../../../src";
import {
  createNominationHarness,
  nominationChecklist,
  type ScriptedReply,
} from "../../utils";

/**
 * Regular nomination model property (live and provisional checklist): for a
 * random sequence of candidates, checks, nomination replies (held, 401, 487)
 * and elapsed time, the agent nominates once, only a pair the model allows,
 * and recovers from the replies as the model says.
 *
 * CI runs `WERIFT_ICE_REGULAR_SEEDS` (default 60) seeds of
 * `WERIFT_ICE_REGULAR_STEPS` (default 30) operations from
 * `WERIFT_ICE_REGULAR_SEED` (default 1), each on both checklists. A failing
 * title prints the replay environment.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const LOW = 100;
const MID = 1_000_000;
const HIGH = 2_000_000_000;
/** `DEFAULT_NOMINATION_DELAY_MS`. */
const DELAY = 300;

describe(
  "regular nomination: model property (live / provisional checklist)",
  propertyOptions(),
  () => {
    const PRIORITIES = [LOW, MID, 300_000_000, HIGH];
    const { seeds, steps, replay, title } = propertySeeds(
      "WERIFT_ICE_REGULAR",
      {
        seeds: 60,
        steps: 30,
      },
    );

    test.each(
      seeds.flatMap((seed) =>
        (["live", "provisional"] as const).map((checklist) => ({
          seed,
          checklist,
        })),
      ),
    )(title("$checklist checklist"), async ({ seed, checklist }) => {
      // Arrange: seed から nomination の応答 (保留 / 401 / 487)、取り消し後の遅延応答の有無、操作列を決める。
      const random = seededRandom(seed);
      const replies: ScriptedReply[] = [];
      const sentAt: number[] = [];
      const h = createNominationHarness({
        honorSignal: random.chance(0.7),
        nominationReply: () => {
          const reply = random.chance(0.7)
            ? "hold"
            : random.pick([401, 487] as const);
          replies.push(reply);
          sentAt.push(Date.now());
          return reply;
        },
      });
      const list = nominationChecklist(h, checklist);
      const pairs: { pair: CandidatePair; priority: number }[] = [];
      const succeeded = new Set<CandidatePair>();
      const rejected = new Set<CandidatePair>();
      const attempts = new Map<CandidatePair, number>();
      const trace: string[] = [];
      let quietSince: number | undefined;
      let eoc = false;
      let roleChanged = false;
      let pinned: CandidatePair | undefined;
      let exhausted = false;
      let selected: CandidatePair | undefined;
      let processed = 0;
      const why = (what: string) =>
        `${what} (${replay(seed)}; ${trace.join(", ")})`;
      const priorityOf = (pair: CandidatePair) =>
        pairs.find((p) => p.pair === pair)!.priority;
      const pairAt = (port: number) =>
        pairs.find((p) => p.pair.remoteAddr[1] === port)!.pair;
      const best = () =>
        [...succeeded]
          .filter((pair) => !rejected.has(pair))
          .sort((a, b) => priorityOf(b) - priorityOf(a))[0];
      const pendingAbove = (pair: CandidatePair) =>
        pairs.some(
          (p) =>
            p.priority > priorityOf(pair) &&
            p.pair.state !== CandidatePairState.FAILED,
        );
      const pendingCheck = (pair: CandidatePair) =>
        h
          .requestsTo(pair)
          .find((request) => !request.nominate && !request.done);
      const pendingNomination = () =>
        h.nominations().find((request) => !request.done);
      const attemptEnded = (pair: CandidatePair) => {
        if ((attempts.get(pair) ?? 0) >= 3) exhausted = true;
      };

      /** Check the USE-CANDIDATE checks sent since the last step, in order. */
      const observeNominations = () => {
        const sent = h.nominations();
        for (; processed < sent.length; processed++) {
          const pair = pairAt(sent[processed].addr[1]);
          const reply = replies[processed];
          attempts.set(pair, (attempts.get(pair) ?? 0) + 1);
          trace.push(`nominate:${priorityOf(pair)}=${reply}`);
          // Assert: 選択後・ロール変更後・断念後には送らず、通常 check の成功した pair にだけ送る。
          expect(
            selected,
            why("USE-CANDIDATE after the selection"),
          ).toBeUndefined();
          expect(roleChanged, why("USE-CANDIDATE after the role change")).toBe(
            false,
          );
          expect(exhausted, why("USE-CANDIDATE after giving up")).toBe(false);
          expect(
            succeeded.has(pair),
            why("USE-CANDIDATE to a pair whose check did not succeed"),
          ).toBe(true);
          if (pinned) {
            // Assert: 応答のなかった nomination の後は、同じ pair にだけ計 3 回まで送る。
            expect(
              pair,
              why("moved to another pair after an unanswered nomination"),
            ).toBe(pinned);
            expect(
              attempts.get(pair),
              why("more than 3 attempts"),
            ).toBeLessThanOrEqual(3);
          } else {
            // Assert: 最良の valid pair にだけ、遅延が過ぎた後か両端 EOC で上位に未完了がないときに送る。
            expect(pair, why("not the best valid pair")).toBe(best());
            const at = sentAt[processed];
            expect(
              at >= (quietSince ?? at) + DELAY || (eoc && !pendingAbove(pair)),
              why("nominated before the delay"),
            ).toBe(true);
          }
          if (reply === 487) {
            // Assert: 487 では controlled になり、pair は valid のまま。
            roleChanged = true;
            expect(
              h.connection.iceControlling,
              why("487 did not switch the role"),
            ).toBe(false);
            expect(pair.state, why("487 failed the pair")).not.toBe(
              CandidatePairState.FAILED,
            );
          } else if (reply === 401) {
            if (pinned) attemptEnded(pair);
            else rejected.add(pair);
          }
        }
      };

      try {
        for (let step = 0; step < steps; step++) {
          const checking = pairs.filter((p) => pendingCheck(p.pair));
          const nomination = pendingNomination();
          const actions = [
            ...(pairs.length < PRIORITIES.length && !eoc ? ["add", "add"] : []),
            ...(checking.length > 0 ? ["succeed", "succeed", "fail"] : []),
            ...(nomination ? ["answer", "timeout", "timeout"] : []),
            "advance",
            ...(!eoc && pairs.length > 0 ? ["eoc"] : []),
            ...(!roleChanged && random.chance(0.05) ? ["role"] : []),
          ];
          const action = random.pick(actions);

          // Act: seed の操作を 1 つ行う。
          if (action === "add") {
            const priority = random.pick(
              PRIORITIES.filter((p) => !pairs.some((q) => q.priority === p)),
            );
            const pair = await list.add(priority);
            trace.push(`add:${priority}`);
            if (pair) {
              const top = best();
              if (top && priority > priorityOf(top)) quietSince = Date.now();
              pairs.push({ pair, priority });
            }
          } else if (action === "succeed" || action === "fail") {
            const { pair, priority } = random.pick(checking);
            trace.push(`${action}:${priority}`);
            pendingCheck(pair)!.release(
              action === "succeed" ? "success" : "failure",
            );
            if (action === "succeed") {
              succeeded.add(pair);
              quietSince ??= Date.now();
            }
          } else if (action === "answer" || action === "timeout") {
            const pair = pairAt(nomination!.addr[1]);
            trace.push(`${action}:${priorityOf(pair)}`);
            nomination!.release(action === "answer" ? "success" : "failure");
            if (!roleChanged && !exhausted) {
              if (action === "answer") selected ??= pair;
              else {
                pinned ??= pair;
                attemptEnded(pair);
              }
            }
          } else if (action === "advance") {
            const ms = random.pick([0, 50, 150, 300, 1000]);
            trace.push(`advance:${ms}`);
            await vi.advanceTimersByTimeAsync(ms);
          } else if (action === "eoc") {
            trace.push("eoc");
            eoc = true;
            await list.endOfCandidates();
          } else {
            trace.push("role");
            roleChanged = true;
            h.switchRole(false);
          }
          await vi.advanceTimersByTimeAsync(0);
          observeNominations();

          // Assert: nomination は同時に 1 つだけ。成功応答を受けた pair だけが選択され、選択は変わらない。
          expect(
            h.nominations().filter((request) => !request.done).length,
            why("several nominations in flight"),
          ).toBeLessThanOrEqual(1);
          expect(list.nominated(), why("selection")).toBe(selected);
          // Assert: 3 回とも応答がなければ断念する (live は failed、provisional は agent を failed にしない)。
          if (list.kind === "live") {
            expect(h.connection.state === "failed", why("failed state")).toBe(
              exhausted,
            );
          } else {
            expect(
              h.connection.state,
              why("provisional failed the agent"),
            ).not.toBe("failed");
          }
          // Assert: 指名できる状態なら、指名を待たせない。
          const top = best();
          if (
            top &&
            !roleChanged &&
            !exhausted &&
            !selected &&
            !pendingNomination()
          ) {
            const due =
              Date.now() >= (quietSince ?? Infinity) + DELAY ||
              (eoc && !pendingAbove(top));
            expect(due, why("a due nomination was not sent")).toBe(false);
          }
        }
      } finally {
        await h.connection.close();
      }
    });
  },
);
