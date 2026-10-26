import { setTimeout as delay } from "node:timers/promises";

import { CandidatePairState } from "../../src/iceBase";
import {
  checkProvisionalPair,
  createScriptedCheckHarness,
  createTestConnection,
  createUnansweredCheckAgent,
  inviteAccept,
  provisionalGeneration,
  queuedCheckListResults,
  waitUntil,
} from "../utils";

/** STUN transactions the sockets of `agent` wait on. */
function liveTransactions(agent: ReturnType<typeof createTestConnection>) {
  return (
    agent as unknown as {
      protocols: { transactions?: Record<string, unknown> }[];
    }
  ).protocols.reduce(
    (sum, p) => sum + Object.keys(p.transactions ?? {}).length,
    0,
  );
}

describe("connectivity checks of a replaced checklist", () => {
  test("a restart stops the retransmissions of the checks in flight", async () => {
    // Arrange: 応答のない相手への check が再送待ちになっている agent。
    const { agent, transactions } = await createUnansweredCheckAgent();
    void agent.connect().catch(() => undefined);
    await delay(100);
    expect(transactions()).toBeGreaterThan(0);

    try {
      // Act: ICE restart で checklist を置き換える。
      await agent.restart();
      await delay(50);

      // Assert: 置き換えた checklist の check は再送をやめ、待っている transaction が残らない。
      expect(transactions()).toBe(0);
    } finally {
      await agent.close();
    }
  });

  test("a restart stops a regular nomination in flight (real sockets)", async () => {
    // Arrange: 相手を ICE-lite とみなして通常 nomination を使う controlling agent と、
    // USE-CANDIDATE 付きの request にだけ応答しない controlled agent。
    const a = createTestConnection(true, { useIpv6: false });
    const b = createTestConnection(false, {
      useIpv6: false,
      filterStunResponse: (message) =>
        !message.attributesKeys.includes("USE-CANDIDATE"),
    });
    await inviteAccept(a, b);
    a.remoteIsLite = true;
    void a.connect().catch(() => undefined);
    void b.connect().catch(() => undefined);

    try {
      // check が成功し、応答のない nomination が送られるまで待つ。
      await waitUntil(
        () => (a as unknown as { nominating: boolean }).nominating,
      );
      expect(liveTransactions(a)).toBeGreaterThan(0);

      // Act: nomination の応答待ちのまま ICE restart する。
      await a.restart();
      await delay(1500);

      // Assert: 古い世代の nomination は再送をやめ、transaction が残らない。
      expect(liveTransactions(a)).toBe(0);
    } finally {
      await a.close();
      await b.close();
    }
  }, 10_000);
});

describe("generation-scoped cancellation of check and nomination transactions", () => {
  test("restart cancels a regular nomination and leaves the new generation untouched", async () => {
    // Arrange: check は成功し、通常 nomination は応答しない（相手は ICE-lite）。
    const h = createScriptedCheckHarness({
      remoteIsLite: true,
      reply: ({ nominate }) => (nominate ? "hold" : "success"),
    });
    const pair = h.addPair();
    const check = h.check(pair);
    await waitUntil(() => h.protocol.requests.some((r) => r.nominate));
    expect(h.protocol.pending()).toBe(1);

    // Act: nomination の応答待ちのまま ICE restart する。
    await h.connection.restart();
    await check.awaitable;

    // Assert: nomination の transaction は取り消され、check の handle も決着する。
    expect(h.protocol.pending()).toBe(0);
    // Assert: 古い pair は FAILED に書き換えられず、新しい世代の nominating も立たない。
    expect(pair.state).not.toBe(CandidatePairState.FAILED);
    expect(h.nominating()).toBe(false);
    await h.connection.close();
  });

  test("a regular nomination that fails after a restart does not touch the new generation", async () => {
    // Arrange: signal を無視する（restart の後に結果が届く）通常 nomination が応答待ち。
    const h = createScriptedCheckHarness({
      remoteIsLite: true,
      honorSignal: false,
      reply: ({ nominate }) => (nominate ? "hold" : "success"),
    });
    const oldPair = h.addPair();
    h.check(oldPair);
    await waitUntil(() => h.protocol.requests.some((r) => r.nominate));
    const oldNomination = h.protocol.requests.find((r) => r.nominate)!;
    await h.connection.restart();
    // 新しい世代でも check が成功し、その nomination が応答待ちになる。
    h.setRemoteCredentials();
    const newPair = h.addPair();
    h.check(newPair);
    await waitUntil(
      () => h.protocol.requests.filter((r) => r.nominate).length === 2,
    );
    expect(h.nominating()).toBe(true);
    const queued = queuedCheckListResults(h.connection);

    // Act: 古い世代の nomination が後から失敗する。
    oldNomination.release("failure");
    await delay(0);

    // Assert: 新しい世代の nominating・pair の状態・checklist の結果は書き換わらない。
    expect(h.nominating()).toBe(true);
    expect(newPair.state).toBe(CandidatePairState.IN_PROGRESS);
    expect(oldPair.state).not.toBe(CandidatePairState.FAILED);
    expect(queuedCheckListResults(h.connection)).toBe(queued);
    await h.connection.close();
  });

  test("restart cancels a TCP regular nomination", async () => {
    // Arrange: TCP の check は成功し、TCP の通常 nomination は応答しない。
    const h = createScriptedCheckHarness({
      transport: "tcp",
      reply: ({ nominate }) => (nominate ? "hold" : "success"),
    });
    const pair = h.addPair();
    h.check(pair);
    await waitUntil(() => h.protocol.requests.some((r) => r.nominate));
    expect(h.protocol.pending()).toBe(1);

    // Act: TCP nomination の応答待ちのまま ICE restart する。
    await h.connection.restart();
    await delay(0);

    // Assert: TCP nomination の transaction が取り消され、古い pair は FAILED にならない。
    expect(h.protocol.pending()).toBe(0);
    expect(pair.state).not.toBe(CandidatePairState.FAILED);
    expect(h.nominating()).toBe(false);
    await h.connection.close();
  });

  test.each([487, 401] as const)(
    "restart cancels the check retried after a %d response",
    async (code) => {
      // Arrange: 最初の check は error 応答、やり直しの check は応答しない。
      const h = createScriptedCheckHarness({
        reply: ({ index }) => (index === 0 ? code : "hold"),
      });
      const pair = h.addPair();
      const check = h.check(pair);
      await waitUntil(() => h.protocol.requests.length === 2);
      expect(h.protocol.pending()).toBe(1);

      // Act: やり直しの check の応答待ちのまま ICE restart する。
      await h.connection.restart();
      await check.awaitable;

      // Assert: やり直しの check も取り消され、transaction が残らない。
      expect(h.protocol.pending()).toBe(0);
      await h.connection.close();
    },
  );

  test("resolving the check handle cancels its 487 retry", async () => {
    // Arrange: 最初の check は 487、やり直しの check は応答しない。
    const h = createScriptedCheckHarness({
      reply: ({ index }) => (index === 0 ? 487 : "hold"),
    });
    const pair = h.addPair();
    h.check(pair);
    await waitUntil(() => h.protocol.requests.length === 2);

    // Act: checklist の完了・置き換えと同じく pair の handle を決着させる。
    pair.handle!.resolve();
    await delay(0);

    // Assert: handle が指す元の check と一緒に、やり直しの check も取り消される。
    expect(h.protocol.pending()).toBe(0);
    await h.connection.close();
  });

  test("close cancels a regular nomination in flight", async () => {
    // Arrange: 通常 nomination が応答待ち。
    const h = createScriptedCheckHarness({
      remoteIsLite: true,
      reply: ({ nominate }) => (nominate ? "hold" : "success"),
    });
    const check = h.check(h.addPair());
    await waitUntil(() => h.protocol.requests.some((r) => r.nominate));

    // Act: agent を閉じる。
    await h.connection.close();
    await check.awaitable;

    // Assert: protocol 側の close を待たずに nomination の transaction が取り消される。
    expect(h.protocol.pending()).toBe(0);
  });

  test("ending the provisional generation cancels its regular nomination", async () => {
    // Arrange: 仮の世代（pranswer の ICE restart）の check は成功し、通常 nomination は応答しない。
    const h = createScriptedCheckHarness({
      remoteIsLite: true,
      reply: ({ nominate }) => (nominate ? "hold" : "success"),
    });
    h.connection.stageLocalCredentials("provA", "provisional-password-a-000");
    h.connection.setProvisionalRemoteParams({
      usernameFragment: "remote",
      password: "remote-password-0000000000",
    });
    const pair = h.addPair();
    h.connection.checkList.pop();
    provisionalGeneration(h.connection)!.pairs.push(pair);
    const check = checkProvisionalPair(h.connection, pair);
    await waitUntil(() => h.protocol.requests.some((r) => r.nominate));
    expect(h.protocol.pending()).toBe(1);

    // Act: 仮の世代を捨てる（rollback と同じ経路）。
    h.connection.discardStagedLocalCredentials("provA");
    await check;

    // Assert: 仮の世代の nomination の transaction も取り消される。
    expect(h.protocol.pending()).toBe(0);
    expect(pair.nominated).toBe(false);
    await h.connection.close();
  });
});
