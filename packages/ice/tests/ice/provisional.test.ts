import {
  checkProvisionalPair,
  createConnectedPair,
  expectDataFlows,
  holdNextCheckResponse,
  provisionalGeneration,
  recordCheckRequests,
  sendRoleConflictCheck,
  stageProvisionalGeneration,
  waitProvisionalNominated,
} from "../utils";

describe("provisional ICE generation", () => {
  test("checks and nominates a staged generation beside the selected pair", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: 現行 generation の資格情報と selected pair を控える。
      const selected = { a: a.nominated, b: b.nominated };
      const current = {
        localA: a.localUsername,
        remoteA: a.remoteUsername,
        localB: b.localUsername,
      };
      await stageProvisionalGeneration(a, b);

      // Act: 両側で provisional checks を開始する。
      a.startProvisionalChecks();
      b.startProvisionalChecks();
      const provisionalA = await waitProvisionalNominated(a);
      const provisionalB = await waitProvisionalNominated(b);

      // Assert: 新 generation は別の pair で nominate され、current は置き換わらない。
      expect(provisionalA).not.toBe(selected.a);
      expect(provisionalB).not.toBe(selected.b);
      expect(a.nominated).toBe(selected.a);
      expect(b.nominated).toBe(selected.b);
      expect(a.localUsername).toBe(current.localA);
      expect(a.remoteUsername).toBe(current.remoteA);
      expect(b.localUsername).toBe(current.localB);
      expect(a.checkList).not.toContain(provisionalA);
      // Assert: データは current の selected pair で双方向に流れ続ける。
      await expectDataFlows(a, b, "provisional-a-to-b");
      await expectDataFlows(b, a, "provisional-b-to-a");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("a replacement remote generation resets the checklist and discard drops it", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: provisional generation を nominate まで進める。
      const selected = a.nominated;
      const credentials = await stageProvisionalGeneration(a, b);
      a.startProvisionalChecks();
      b.startProvisionalChecks();
      await waitProvisionalNominated(a);

      // Act: 同じ資格情報の再適用 (重複) と、別資格情報の replacement を適用する。
      a.setProvisionalRemoteParams(credentials.b);
      const afterDuplicate = a.provisionalNominated;
      a.setProvisionalRemoteParams({
        usernameFragment: "provB2",
        password: "provisional-password-b-001",
      });

      // Assert: 重複は冪等で、replacement は provisional nomination を破棄する。
      expect(afterDuplicate).toBeDefined();
      expect(a.provisionalNominated).toBeUndefined();

      // Act: staged 資格情報を破棄する (rollback)。
      a.discardStagedLocalCredentials(credentials.a.usernameFragment);
      b.discardStagedLocalCredentials(credentials.b.usernameFragment);

      // Assert: provisional は残らず、current pair と通信はそのまま。
      expect(a.provisionalNominated).toBeUndefined();
      expect(b.provisionalNominated).toBeUndefined();
      expect(a.userHistory[credentials.a.usernameFragment]).toBeUndefined();
      expect(a.nominated).toBe(selected);
      await expectDataFlows(a, b, "after-discard");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("commit after restart adopts the staged local credentials", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: staged generation を用意する。
      const credentials = await stageProvisionalGeneration(a, b);
      const generation = a.generation;

      // Act: final answer 相当として restart 後に staged 資格情報を commit する。
      a.restart();
      a.commitLocalCredentials(
        credentials.a.usernameFragment,
        credentials.a.password,
      );

      // Assert: live 資格情報が staged のものになり、provisional は解放される。
      expect(a.localUsername).toBe(credentials.a.usernameFragment);
      expect(a.localPassword).toBe(credentials.a.password);
      expect(a.generation).toBeGreaterThan(generation);
      expect(a.provisionalNominated).toBeUndefined();
      expect(a.nominated).toBeUndefined();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("a check answered after a replacement pranswer cannot nominate the new checklist", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: provisional generation の check を 1 つ応答待ちにする。
      await stageProvisionalGeneration(a, b);
      const pair = provisionalGeneration(a)!.pairs[0];
      const held = holdNextCheckResponse(pair);
      const check = checkProvisionalPair(a, pair);

      // Act: 応答待ちの間に replacement pranswer で remote 資格情報を置き換え、旧応答を受ける。
      a.setProvisionalRemoteParams({
        usernameFragment: "provB2",
        password: "provisional-password-b-001",
      });
      held.release();
      await check;

      // Assert: 旧 checklist の pair は新しい checklist に属さず、nominate もされない。
      expect(provisionalGeneration(a)!.pairs).not.toContain(pair);
      expect(a.provisionalNominated).toBeUndefined();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("the provisional checklist applies filterCandidatePair like the live one", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: 確立後に a の候補 pair をすべて拒否する filter を設定する。
      a.options.filterCandidatePair = () => false;
      await stageProvisionalGeneration(a, b);

      // Act: a だけ provisional checks を開始する。
      a.startProvisionalChecks();

      // Assert: filter に拒否された pair は provisional checklist に入らず、nominate もされない。
      expect(provisionalGeneration(a)!.pairs).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(a.provisionalNominated).toBeUndefined();
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("an ICE-lite agent sends no provisional checks", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: controlled 側の b を ICE-lite として provisional generation を用意する。
      b.options.iceLite = true;
      await stageProvisionalGeneration(a, b);
      const sent = recordCheckRequests(b);

      // Act: b で provisional checks を開始する。
      b.startProvisionalChecks();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Assert: ICE-lite は接続確認を送らない (応答だけを行う)。
      expect(sent.count()).toBe(0);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("a role conflict on a staged ufrag is answered with that generation's password", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: 両側に provisional generation を用意する (b は controlled)。
      const credentials = await stageProvisionalGeneration(a, b);

      // Act: b の staged ufrag 宛てに role conflict になる check を送る。
      const code = await sendRoleConflictCheck(a, {
        remoteUfrag: credentials.b.usernameFragment,
        localUfrag: credentials.a.usernameFragment,
        remotePassword: credentials.b.password,
      });

      // Assert: 487 応答は staged password で署名され、送信側で検証できる。
      expect(code).toBe(487);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  test("a full agent nominates a provisional pair toward an ICE-lite peer", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: controlled 側の b を ICE-lite とし、a はそれを相手の性質として知っている。
      b.options.iceLite = true;
      a.remoteIsLite = true;
      await stageProvisionalGeneration(a, b);

      // Act: 両側で provisional checks を開始する (ICE-lite の b は応答だけを行う)。
      a.startProvisionalChecks();
      b.startProvisionalChecks();

      // Assert: a は check 成功後に USE-CANDIDATE 付きの check で regular nomination を行い、
      // 両側の provisional generation で同じ経路が nominate される。
      const nominatedA = await waitProvisionalNominated(a);
      const nominatedB = await waitProvisionalNominated(b);
      expect(nominatedA.remoteAddr[1]).toBe(nominatedB.localCandidate.port);
      expect(nominatedB.remoteAddr[1]).toBe(nominatedA.localCandidate.port);
      expect(nominatedA.nominated).toBe(true);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
