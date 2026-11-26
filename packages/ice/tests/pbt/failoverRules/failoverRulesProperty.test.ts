import { describe, expect, test } from "vitest";

import {
  propertyOptions,
  propertySeeds,
  seededRandom,
} from "../../../../pbt/src";
import {
  DEFAULT_FAILOVER_THRESHOLDS,
  isNotReceiving,
  isUnwritable,
  isWeak,
  isWritable,
  nextPingAt,
  notReceivingSince,
  resolveFailoverThresholds,
} from "../../../src/failover";
import {
  DATA_SEND_CONFIRM_INTERVAL_MS,
  DataSendConfirmation,
  isPathBrokenSendError,
  PATH_BROKEN_SEND_ERRORS,
} from "../../../src/stun/protocol";
import { drawLivenessCase } from "./generator";

/**
 * Failover rules property (ticket 6b2d7627 §15): the pure rules behind the
 * timing properties, for random inputs:
 * - `resolveFailoverThresholds` keeps each valid value and the default for
 *   any other;
 * - the liveness rules (`isUnwritable`, `isWeak`, `isNotReceiving`,
 *   `isWritable`, `nextPingAt`) are consistent with each other and monotonic
 *   in time and in the thresholds;
 * - a pair is not receiving (`notReceivingSince`) exactly from the later of
 *   `receivingTimeout` of silence and its first unanswered check
 *   (`missedSince`), and `isNotReceiving` holds exactly once
 *   `receivingSwitchingDelay` passed since then; a coverage check (skipped
 *   when a seed is selected) asserts that the default seeds draw pairs
 *   receiving, in the hold and past it;
 * - a send error is a broken path exactly for the routing codes, and data
 *   sends are confirmed once per 100 ms.
 *
 * CI runs `WERIFT_ICE_FAILOVER_RULES_SEEDS` (default 200) seeds from
 * `WERIFT_ICE_FAILOVER_RULES_SEED` (default 1). A failing title prints the
 * replay environment.
 */
describe("§15 pure rules (properties)", propertyOptions(), () => {
  const { seeds, cases, replay, title, seedSelected } = propertySeeds(
    "WERIFT_ICE_FAILOVER_RULES",
    {
      seeds: 200,
      steps: 1,
    },
  );

  test.each(cases)(
    title(
      "resolveFailoverThresholds keeps each valid value and the default for any other",
    ),
    ({ seed }) => {
      // Arrange: 項目ごとに未指定・範囲内・範囲外・非有限・小数を引く。
      const random = seededRandom(seed);
      const draw = () =>
        random.pick([
          undefined,
          random.int(0, 10_000),
          random.int(1, 8),
          -random.int(1, 1000),
          0,
          0.5,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ]);
      const options = {
        unwritableMinChecks: draw(),
        unwritableTimeout: draw(),
        receivingTimeout: draw(),
        receivingSwitchingDelay: draw(),
      };
      const valid = {
        unwritableMinChecks: (v: number) => Number.isInteger(v) && v >= 1,
        unwritableTimeout: (v: number) => v >= 0,
        receivingTimeout: (v: number) => v > 0,
        receivingSwitchingDelay: (v: number) => v >= 0,
      };

      // Act: 既定値を補う。
      const resolved = resolveFailoverThresholds(options);

      // Assert: 有限で範囲内の値はそのまま、ほかは libwebrtc の既定値 (5・5000・2500・1000 ms)。
      for (const key of Object.keys(valid) as (keyof typeof valid)[]) {
        const value = options[key];
        const keep =
          typeof value === "number" &&
          Number.isFinite(value) &&
          valid[key](value);
        expect(resolved[key], `${replay(seed)} ${key}=${value}`).toBe(
          keep ? value : DEFAULT_FAILOVER_THRESHOLDS[key],
        );
      }
      expect(DEFAULT_FAILOVER_THRESHOLDS).toEqual({
        unwritableMinChecks: 5,
        unwritableTimeout: 5000,
        receivingTimeout: 2500,
        receivingSwitchingDelay: 1000,
      });
    },
  );

  test.each(cases)(
    title(
      "the liveness rules are consistent and monotonic (in time and in the thresholds)",
    ),
    ({ seed }) => {
      // Arrange: ペアの状態・時刻・閾値を引く。
      const { liveness, now, later, thresholds, random } =
        drawLivenessCase(seed);
      const looser = {
        ...thresholds,
        unwritableMinChecks: thresholds.unwritableMinChecks + random.int(0, 3),
        unwritableTimeout: thresholds.unwritableTimeout + random.int(0, 3000),
        receivingTimeout: thresholds.receivingTimeout + random.int(0, 3000),
      };
      const lastSentAt = random.int(0, now);
      const stable = random.int(900, 6_000);
      const label = `${replay(seed)} ${JSON.stringify({ liveness, now, thresholds, lastSentAt, stable })}`;

      // Act: 各規則を評価する。
      const unwritable = isUnwritable(liveness, now, thresholds);
      const weak = isWeak(liveness, now, thresholds);
      const notReceiving = isNotReceiving(liveness, now, thresholds);
      const writable = isWritable(liveness, now, thresholds);
      const due = nextPingAt(liveness, lastSentAt, stable, thresholds);

      // Assert: 受信途絶なら weak。書き込み可能は「応答を受けたことがあり、書き込み不可でない」。broken は書き込み不可。
      if (notReceiving) expect(weak, label).toBe(true);
      expect(writable, label).toBe(
        liveness.lastResponse !== undefined && !unwritable,
      );
      if (liveness.broken) expect(unwritable, label).toBe(true);
      // Assert: 時間が進んでも書き込み不可・受信途絶・weak は解けない (応答や受信がない限り)。
      if (unwritable)
        expect(isUnwritable(liveness, later, thresholds), label).toBe(true);
      if (notReceiving)
        expect(isNotReceiving(liveness, later, thresholds), label).toBe(true);
      if (weak) expect(isWeak(liveness, later, thresholds), label).toBe(true);
      // Assert: 閾値を緩めると書き込み不可・受信途絶になりにくくなるだけ。
      if (isUnwritable(liveness, now, looser))
        expect(unwritable, label).toBe(true);
      if (isNotReceiving(liveness, now, looser))
        expect(notReceiving, label).toBe(true);
      // Assert: 次の check は weak の間隔 (900 ms) より早くならない。未応答・broken なら 900 ms ちょうど。
      // それ以外は安定時の間隔と無受信 receivingTimeout の早い方 (ただし 900 ms 以上)。
      const weakAt = lastSentAt + 900;
      expect(due, label).toBeGreaterThanOrEqual(weakAt);
      if (liveness.unanswered > 0 || liveness.broken) {
        expect(due, label).toBe(weakAt);
      } else {
        expect(due, label).toBe(
          Math.max(
            weakAt,
            Math.min(
              lastSentAt + stable,
              liveness.lastReceived + thresholds.receivingTimeout,
            ),
          ),
        );
      }
      // Assert: 閾値を省略すると既定値で評価する。
      expect(isUnwritable(liveness, now), label).toBe(
        isUnwritable(liveness, now, DEFAULT_FAILOVER_THRESHOLDS),
      );
    },
  );

  test.skipIf(seedSelected)(
    title(
      "the default seeds cover pairs receiving, in the hold and past it (isNotReceiving is exercised)",
    ),
    () => {
      // Arrange / Act: 既定の seed の事例を、受信中・保留中・受信停止に分類する。
      const counts = { receiving: 0, holding: 0, notReceiving: 0 };
      for (const seed of seeds) {
        const { liveness, now, thresholds } = drawLivenessCase(seed);
        const since = notReceivingSince(
          liveness,
          now,
          thresholds.receivingTimeout,
        );
        if (since === undefined) counts.receiving++;
        else if (isNotReceiving(liveness, now, thresholds)) {
          counts.notReceiving++;
        } else counts.holding++;
      }

      // Assert: 受信停止が成立した事例が十分あり、保留中・受信中の事例も含まれる。
      const label = JSON.stringify(counts);
      expect(counts.notReceiving, label).toBeGreaterThanOrEqual(
        seeds.length / 10,
      );
      expect(counts.holding, label).toBeGreaterThan(0);
      expect(counts.receiving, label).toBeGreaterThan(0);
    },
  );

  test.each(cases)(
    title(
      "a pair is not receiving exactly from the later of the silence and the unanswered check, plus the hold",
    ),
    ({ seed }) => {
      // Arrange: missedSince つきの状態と閾値を引く。
      const { liveness, now, thresholds } = drawLivenessCase(seed);
      const label = `${replay(seed)} ${JSON.stringify({ liveness, now, thresholds })}`;
      const silentAt = liveness.lastReceived + thresholds.receivingTimeout;

      // Act: 受信停止の開始時刻と判定を求める。
      const since = notReceivingSince(
        liveness,
        now,
        thresholds.receivingTimeout,
      );
      const notReceiving = isNotReceiving(liveness, now, thresholds);

      // Assert: 無通信と未応答の両方が揃った時点が開始で、保留を過ぎて初めて受信停止になる。
      if (liveness.missedSince === undefined || now < silentAt) {
        expect(since, label).toBeUndefined();
        expect(notReceiving, label).toBe(false);
      } else {
        expect(since, label).toBe(Math.max(silentAt, liveness.missedSince));
        expect(notReceiving, label).toBe(
          now - since! >= thresholds.receivingSwitchingDelay,
        );
      }
    },
  );

  test.each(cases)(
    title(
      "a send error is a broken path exactly for the routing codes; data sends are confirmed once per 100 ms",
    ),
    ({ seed }) => {
      // Arrange: エラーコードと、増加する送信時刻の列を引く。
      const random = seededRandom(seed);
      const code = random.pick([
        ...PATH_BROKEN_SEND_ERRORS,
        "EINVAL",
        "EACCES",
        "EMSGSIZE",
        "ECONNREFUSED",
        "ENOBUFS",
        "",
      ]);
      const error = random.chance(0.9)
        ? Object.assign(new Error(`send ${code}`), { code })
        : { code };
      const times: number[] = [];
      let t = random.int(0, 1000);
      for (let i = 0; i < random.int(1, 60); i++) {
        t += random.pick([0, 1, random.int(0, 50), random.int(50, 150), 100]);
        times.push(t);
      }
      const confirmation = new DataSendConfirmation();

      // Act: 分類と、送信ごとの確認の要否を求める。
      const broken = isPathBrokenSendError(error);
      const confirmed = times.filter((time) => confirmation.due(time));

      // Assert: Error で、経路のエラーコードのときだけ経路の消失とみなす。
      expect(broken, `${replay(seed)} ${code}`).toBe(
        error instanceof Error && PATH_BROKEN_SEND_ERRORS.has(code),
      );
      // Assert: 最初の送信は確認し、確認どうしは 100 ms 以上離れ、前の確認から 100 ms 経った最初の送信は必ず確認する。
      let last = Number.NEGATIVE_INFINITY;
      const expected = times.filter((time) => {
        if (time - last < DATA_SEND_CONFIRM_INTERVAL_MS) return false;
        last = time;
        return true;
      });
      expect(confirmed, `${replay(seed)} ${times}`).toEqual(expected);
    },
  );
});
