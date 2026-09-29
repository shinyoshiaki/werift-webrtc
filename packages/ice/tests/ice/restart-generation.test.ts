import { CandidatePairState } from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import { createConnectedPair } from "../utils";

type Internals = {
  protocols: Protocol[];
  checkComplete(pair: unknown): void;
};

describe("ICE restart generation boundaries", () => {
  test("a late check addressed to the previous ufrag does not relabel the live candidate", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: a を restart し、旧 ufrag を控える。
      const previous = a.localUsername;
      await a.restart();
      await a.gatherCandidates();
      const protocol = (a as unknown as Internals).protocols.find(
        (candidate) => candidate.localCandidate?.transport === "udp",
      )!;
      expect(protocol.localCandidate!.ufrag).toBe(a.localUsername);

      // Act: b から旧 ufrag 宛ての check (旧 pair の consent 相当) が届く。
      const request = new Message(methods.BINDING, classes.REQUEST)
        .setAttribute("USERNAME", `${previous}:${b.localUsername}`)
        .setAttribute("PRIORITY", 1);
      const remote = b.localCandidates[0];
      a.checkIncoming(request, [remote.host, remote.port], protocol);

      // Assert: live な host candidate は新 generation の ufrag のまま。
      expect(protocol.localCandidate!.ufrag).toBe(a.localUsername);
      expect(protocol.localCandidate!.ufrag).not.toBe(previous);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  });

  test("a check that completes after a restart cannot select a pair of the discarded checklist", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: restart 前の selected pair を控えて restart する。
      const stale = a.nominated!;
      await a.restart();
      expect(a.checkList).not.toContain(stale);

      // SDP 由来の remote candidate は generation を持たない (旧 guard では区別できない)。
      stale.remoteCandidate.generation = undefined;

      // Act: 旧 checklist の pair が restart 後に成功・nominate 済みとして完了する。
      stale.updateState(CandidatePairState.SUCCEEDED);
      stale.nominated = true;
      (a as unknown as Internals).checkComplete(stale);

      // Assert: 新 generation の selected pair にはならない。
      expect(a.nominated).toBeUndefined();
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  });
});
