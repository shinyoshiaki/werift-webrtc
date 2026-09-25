import {
  createConnectedPair,
  expectDataFlows,
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
});
