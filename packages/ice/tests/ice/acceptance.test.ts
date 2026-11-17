import { describe, expect, test, vi } from "vitest";

import { CandidatePairState, type IceOptions } from "../../src";
import {
  createDelayedPreferredPathPair,
  expectDataFlows,
  selectSamePath,
} from "../utils";

/**
 * Acceptance test of ticket 05c13603: a lower-priority pair (TURN relay)
 * connects first, and when the higher-priority pair (host ↔ host) becomes
 * reachable later both agents move to it and exchange data on one 5-tuple.
 * Real sockets and a local TURN server; the host pair's requests are held
 * until `open()`.
 */
describe("acceptance: a better path that works later is taken by both agents", () => {
  test.each<{
    mode: string;
    options: {
      renomination?: boolean;
      nomination?: IceOptions["nomination"];
      nominationDelayMs?: number;
    };
  }>([
    { mode: "semi-aggressive", options: {} },
    { mode: "renomination", options: { renomination: true } },
  ])(
    "($mode) 9章: 下位ペアで接続した後、上位ペアが通ると両端が上位ペアへ移る",
    async ({ options }) => {
      const { a, b, open, selectsPreferred, close } =
        await createDelayedPreferredPathPair(options);

      try {
        // Act: 上位ペア (host ↔ host) の request を止めたまま、両端で ICE を実行する。
        await Promise.all([a.connect(), b.connect()]);

        // Assert: 上位ペアを待たずに接続が完了し (接続時間は従来どおり)、両端とも下位ペアを使っている。
        expect(selectsPreferred(a)).toBe(false);
        expect(selectsPreferred(b)).toBe(false);

        // Act: 上位ペアの経路が通るようになる。
        open();

        // Assert: 両端が上位ペアへ移り、同じ 5-tuple を使う。
        await vi.waitFor(
          () => {
            expect(selectsPreferred(a)).toBe(true);
            expect(selectsPreferred(b)).toBe(true);
          },
          { timeout: 3000 },
        );
        expect(selectSamePath(a, b)).toBe(true);

        // Assert: その経路でデータが双方向に届く。
        await expectDataFlows(a, b, "a to b");
        await expectDataFlows(b, a, "b to a");
      } finally {
        await close();
      }
    },
  );

  test("(regular) 3章・7章: 下位ペアが先に valid になっても、待ち時間内に上位ペアが通れば最初から上位ペアだけを指名する", async () => {
    const { a, b, open, selectsPreferred, relayPair, close } =
      await createDelayedPreferredPathPair({
        nomination: "regular",
        nominationDelayMs: 1000,
      });

    try {
      // Act: 上位ペアの request を止めたまま両端で ICE を始め、下位ペア (relay) が valid になるまで待つ。
      const connecting = Promise.all([a.connect(), b.connect()]);
      await vi.waitFor(() =>
        expect(relayPair(a).state).toBe(CandidatePairState.SUCCEEDED),
      );

      // Assert: regular は最初の valid ペアをすぐには指名せず、待っている。
      expect(a.nominated).toBeUndefined();

      // Act: 待ち時間内に上位ペアの経路が通るようになり、接続が完了する。
      open();
      await connecting;

      // Assert: 下位ペアを一度も指名せず、両端が上位ペアを選択して同じ 5-tuple を使う。
      expect(relayPair(a).nominated).toBe(false);
      expect(selectsPreferred(a)).toBe(true);
      expect(selectsPreferred(b)).toBe(true);
      expect(selectSamePath(a, b)).toBe(true);

      // Assert: その経路でデータが双方向に届く。
      await expectDataFlows(a, b, "a to b");
      await expectDataFlows(b, a, "b to a");
    } finally {
      await close();
    }
  });
});
