import { CandidatePairState } from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import {
  carriedCheckCount,
  commitRestartWithoutCandidates,
  createRenominatedBeforeAnswer,
  createRestartCheckedBeforeAnswer,
  expectDataFlows,
  injectStagedChecksFrom,
  stagedChecks,
  stagedNominations,
  waitUntil,
} from "../utils";

describe("checks a staged ICE restart received before its answer", () => {
  test("the committed generation learns the peer from checks that arrived before the answer", async () => {
    // Arrange: b は a の staged ufrag への check を終え、再送せずに nomination を待つ。
    const { a, b, staged, bConnected } =
      await createRestartCheckedBeforeAnswer();
    try {
      // Act: a が候補を含まない answer で restart を commit し、接続確認を始める。
      await commitRestartWithoutCandidates(a, b, staged);
      await bConnected;

      // Assert: answer 前の check から相手を学び、新 generation で両側が nominate される。
      expect(a.localUsername).toBe(staged.usernameFragment);
      expect(a.nominated).toBeDefined();
      expect(a.nominated!.remoteCandidate.type).toBe("prflx");
      expect(b.nominated).toBeDefined();
      // Assert: 新しい selected pair でデータが双方向に流れ、引き継いだ check は残らない。
      await expectDataFlows(a, b, "after-restart-a-to-b");
      await expectDataFlows(b, a, "after-restart-b-to-a");
      expect(carriedCheckCount(a)).toBe(0);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a replacement offer does not carry the checks of the generation it replaced", async () => {
    // Arrange: b が check した staged generation を、別の ufrag の offer で置き換える。
    const { a, b } = await createRestartCheckedBeforeAnswer();
    const replacement = {
      usernameFragment: "rstA2",
      password: "restart-password-a-0001",
    };
    a.stageLocalCredentials(replacement.usernameFragment, replacement.password);
    try {
      // Act: 置き換えた generation を commit する。
      const connected = commitRestartWithoutCandidates(a, b, replacement);

      // Assert: 旧 ufrag 宛ての check は引き継がれず、使える pair がないので失敗する。
      await expect(connected).rejects.toThrow("ICE negotiation failed");
      expect(a.nominated).toBeUndefined();
      expect(carriedCheckCount(a)).toBe(0);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a rolled back generation's checks are not carried into a later restart", async () => {
    // Arrange: b が check した staged generation を rollback で破棄する。
    const { a, b, staged } = await createRestartCheckedBeforeAnswer();
    a.discardStagedLocalCredentials(staged.usernameFragment);
    try {
      // Act: staged を持たない restart を、同じ ufrag で commit しようとする。
      const connected = commitRestartWithoutCandidates(a, b, staged);

      // Assert: 破棄した generation の check は再生されない。
      await expect(connected).rejects.toThrow("ICE negotiation failed");
      expect(a.nominated).toBeUndefined();
      expect(carriedCheckCount(a)).toBe(0);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("checks from a remote ufrag other than the answer's are not replayed", async () => {
    // Arrange: b が staged ufrag への check を終えている。
    const { a, b, staged } = await createRestartCheckedBeforeAnswer();
    try {
      // Act: check の送信元とは別の remote ufrag を持つ answer で commit する。
      const connected = commitRestartWithoutCandidates(
        a,
        b,
        staged,
        "otherRemote",
      );

      // Assert: 別の remote generation の check は新しい checklist に入らない。
      await expect(connected).rejects.toThrow("ICE negotiation failed");
      expect(a.checkList).toHaveLength(0);
      expect(carriedCheckCount(a)).toBe(0);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("checks from another remote ufrag that filled the store first do not crowd out the answer's", async () => {
    // Arrange: 保存上限を超える別 ufrag の check が先に届いた後、b の正しい check が届く。
    const { a, b, staged, bConnected } = await createRestartCheckedBeforeAnswer(
      (a) => injectStagedChecksFrom(a, "rstA", "otherRemote", 64),
    );
    try {
      // Act: a が候補を含まない answer で restart を commit する。
      await commitRestartWithoutCandidates(a, b, staged);
      await bConnected;

      // Assert: 正しい ufrag の check が残り、接続できてデータが流れる。
      expect(a.nominated).toBeDefined();
      await expectDataFlows(a, b, "after-flood-a-to-b");
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a plain check from the same path does not erase an earlier nomination", async () => {
    // Arrange: staged generation を持つ a に、同じ経路から nomination 付き→通常の順で check を届ける。
    const { a, b } = await createRestartCheckedBeforeAnswer((a) => {
      const port = () => 41000;
      injectStagedChecksFrom(a, "rstA", "peer", 1, {
        useCandidate: true,
        port,
      });
      injectStagedChecksFrom(a, "rstA", "peer", 1, { port });
    });
    try {
      // Act: 保存された、その経路の check を取り出す。
      const kept = stagedChecks(a).filter(
        ([m, addr]) =>
          addr[1] === 41000 &&
          (m.getAttributeValue("USERNAME") as string).endsWith(":peer"),
      );

      // Assert: 経路ごとに 1 件で、先に受けた USE-CANDIDATE が残っている。
      expect(kept).toHaveLength(1);
      expect(kept[0][0].attributesKeys).toContain("USE-CANDIDATE");
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a check received on a TURN allocation the commit replaced still teaches the peer's address", async () => {
    // Arrange: relay allocation 経由で届いた check を持つ a。commit でその allocation は閉じられる。
    const { a, b, staged } = await createRestartCheckedBeforeAnswer();
    const message = new Message(methods.BINDING, classes.REQUEST);
    message
      .setAttribute("USERNAME", `${staged.usernameFragment}:${b.localUsername}`)
      .setAttribute("PRIORITY", 1)
      .setAttribute("USE-CANDIDATE", null);
    const closedRelay = {
      localCandidate: { type: "relay", transport: "udp" },
    } as unknown as Protocol;
    try {
      await a.restart();
      a.commitLocalCredentials(staged.usernameFragment, staged.password);
      (a as unknown as { carriedChecks: unknown[] }).carriedChecks = [
        [message, ["203.0.113.7", 45000], closedRelay],
      ];
      await a.gatherCandidates();
      a.remoteUsername = b.localUsername;
      a.remotePassword = b.localPassword;
      await a.addRemoteCandidate(undefined);

      // Act: 候補のない answer で connect し、先行 check を再生する。
      const connected = a.connect();
      connected.catch(() => {});

      // Assert: 閉じた relay には応答せず、相手のアドレスが prflx 候補として学習される。
      expect(
        a.remoteCandidates.some(
          (c) =>
            c.type === "prflx" && c.host === "203.0.113.7" && c.port === 45000,
        ),
      ).toBe(true);
      // Assert: 旧 relay 上の nomination は現行 pair に持ち越さない（相手が再度 nominate する）。
      expect(a.checkList.some((p) => p.remoteNominated)).toBe(false);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a renomination with a larger value on the same path replaces the stored nomination", async () => {
    // Arrange: answer 前に controlling peer が経路 A=1、B=2、A=3 の順で再指名する。
    const { a, b, paths } = await createRenominatedBeforeAnswer([
      { path: 0, value: 1 },
      { path: 1, value: 2 },
      { path: 0, value: 3 },
    ]);
    try {
      // Act: staged generation が保存した check の NOMINATION を経路ごとに取り出す。
      const stored = stagedNominations(a);
      const at = (path: number) =>
        stored.filter(
          (s) => s.addr[0] === paths[path][0] && s.addr[1] === paths[path][1],
        );

      // Assert: 経路ごとに 1 件で、A は最後に受けた大きい値 3、B は 2 が残る。
      expect(at(0).map((s) => s.nomination)).toEqual([3]);
      expect(at(1).map((s) => s.nomination)).toEqual([2]);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("a plain check or a smaller value after a nomination keeps the path's largest nomination", async () => {
    // Arrange: 同じ経路に NOMINATION 3 の後、値 0（通常の check）と 2 が届く。
    const { a, b, paths } = await createRenominatedBeforeAnswer([
      { path: 0, value: 3 },
      { path: 0, value: 0 },
      { path: 0, value: 2 },
    ]);
    try {
      // Act: 保存された、その経路の check を取り出す。
      const stored = stagedNominations(a).filter(
        (s) => s.addr[0] === paths[0][0] && s.addr[1] === paths[0][1],
      );

      // Assert: 最大の指名 3 が残り、後続の check で消えない。
      expect(stored.map((s) => s.nomination)).toEqual([3]);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("after the commit the controlled agent selects the path the peer renominated last", async () => {
    // Arrange: answer 前に controlling peer が A=1、B=2、A=3 と再指名し、最後に A を選んでいる。
    const { a, b, staged, paths } = await createRenominatedBeforeAnswer([
      { path: 0, value: 1 },
      { path: 1, value: 2 },
      { path: 0, value: 3 },
    ]);
    try {
      // Act: a が候補を含まない answer で restart を commit し、先行 check を再生して接続する。
      await commitRestartWithoutCandidates(a, b, staged);
      // Act: 再生した両経路の triggered check が終わるまで待つ（先に成功した経路が一時的に選ばれうる）。
      await waitUntil(
        () =>
          a.checkList.length === 2 &&
          a.checkList.every((p) => p.state === CandidatePairState.SUCCEEDED),
      );

      // Assert: a は peer が最後に選んだ経路 A を選択する（B=2 で上書きされない）。
      expect(a.nominated).toBeDefined();
      expect(a.nominated!.remoteAddr).toEqual(paths[0]);
      expect(a.nominated!.remoteNomination).toBe(3);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);
});
