import { Connection } from "../../src/ice";
import { CandidatePairState } from "../../src/iceBase";
import { answerChecksOnly, inviteAccept } from "../utils";

describe("Connection role switch nomination", () => {
  test("controlled の間に成功した pair は controlling に切り替わった後に nominate される", async () => {
    // Arrange: a は controlled で checks を走らせ、b (controlling) は受けた check に応答するだけにする
    const a = new Connection(false);
    const b = new Connection(true);
    try {
      await inviteAccept(a, b);
      answerChecksOnly(b);
      const connected = a.connect();
      await vi.waitFor(
        () => {
          expect(
            a.checkList.some(
              (pair) => pair.state === CandidatePairState.SUCCEEDED,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
      // controlled の check は USE-CANDIDATE を持たないので、まだ誰も nominate していない
      expect(a.nominated).toBeUndefined();

      // Act: role conflict の修復と同じく、b を controlled、a を controlling に切り替える
      (b as any).switchRole(false);
      (a as any).switchRole(true);

      // Assert: a が成功済みの pair を USE-CANDIDATE 付きで確認し直して nominate し、connect が完了する
      await connected;
      expect(a.nominated).toBeDefined();
      expect(a.state).toBe("connected");
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }, 15_000);
});
