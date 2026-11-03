import { createConnectedPair } from "../utils";

describe("local credential history across ICE restarts", () => {
  test("keeps only the current and the replaced generation's credentials", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: 現行の資格情報を控える。
      let previous = a.localUsername;

      for (let i = 0; i < 5; i++) {
        // Act: 新しい generation を stage し、restart の commit で採用する (ICE restart の確定)。
        const ufrag = `gen${i}`;
        const password = `restart-password-${i}-0000000`;
        a.stageLocalCredentials(ufrag, password);
        a.restart();
        a.commitLocalCredentials(ufrag, password);

        // Assert: 履歴は置き換えた generation と現行の 2 つだけで、restart ごとに増えない。
        expect(Object.keys(a.userHistory).sort()).toEqual(
          [previous, ufrag].sort(),
        );
        expect(a.userHistory[ufrag]).toBe(password);
        previous = ufrag;
      }
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
});
