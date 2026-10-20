import { Candidate } from "../../src/candidate";
import { CandidatePair, CandidatePairState } from "../../src/iceBase";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import type { Protocol } from "../../src/types/model";
import {
  createConnectedLitePair,
  createConnectedPair,
  deliverLocalCandidates,
} from "../utils";

type Internals = {
  protocols: Protocol[];
  checkComplete(pair: unknown): void;
};

describe("ICE restart generation boundaries", () => {
  test("a remote-only restart toward an ICE-lite peer nominates although its candidates carry another generation number", async () => {
    // Arrange: ICE-lite の相手と接続済みの full agent (相手は check を送らない)。
    const { a, b } = await createConnectedLitePair();
    try {
      // Act: 相手だけが資格情報を変え (generation 1 の候補)、a は local を保ったまま remote を切り替える。
      await b.restart();
      await b.gatherCandidates();
      a.restartRemote();
      a.remoteUsername = b.localUsername;
      a.remotePassword = b.localPassword;
      a.remoteIsLite = true;
      b.remoteUsername = a.localUsername;
      b.remotePassword = a.localPassword;
      await deliverLocalCandidates(b, a, { endOfCandidates: true });
      await deliverLocalCandidates(a, b, { endOfCandidates: true });
      expect(
        b.localCandidates.every((c) => c.generation === b.generation),
      ).toBe(true);
      expect(a.generation).not.toBe(b.generation);
      await Promise.all([a.connect(), b.connect()]);

      // Assert: 次の restart の前に、a は pair を選び、データが双方向に届く。
      expect(a.nominated).toBeDefined();
      const received = { ab: false, ba: false };
      a.onData.subscribe((data) => {
        if (data.toString() === "ba") received.ba = true;
      });
      b.onData.subscribe((data) => {
        if (data.toString() === "ab") received.ab = true;
      });
      for (let i = 0; i < 50 && !(received.ab && received.ba); i++) {
        await Promise.all([
          a.send(Buffer.from("ab")),
          b.send(Buffer.from("ba")),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received).toEqual({ ab: true, ba: true });
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  }, 20000);

  test("dropping other remote generations keeps only the live ufrag's and ufrag-less candidates", async () => {
    const { a, b } = await createConnectedPair();
    try {
      // Arrange: 現在の remote ufrag の候補・ufrag なしの候補・別 generation の候補と、その pair を置く。
      const live = b.localUsername;
      const base = b.localCandidates[0];
      const withUfrag = (ufrag?: string) => {
        const candidate = Candidate.fromSdp(base.toSdp());
        candidate.ufrag = ufrag;
        return candidate;
      };
      const current = withUfrag(live);
      const plain = withUfrag(undefined);
      const stale = withUfrag("old0");
      a.remoteCandidates.splice(
        0,
        a.remoteCandidates.length,
        current,
        plain,
        stale,
      );
      const protocol = a.checkList[0].protocol;
      const stalePair = new CandidatePair(protocol, stale, a.iceControlling);
      a.checkList.push(stalePair);

      // Act: 現在の remote ufrag 以外の generation を落とす。
      a.dropOtherRemoteGenerations(live);

      // Assert: 別 generation の候補とその pair だけが消え、他は残る。
      expect(a.remoteCandidates).toEqual([current, plain]);
      expect(a.checkList).not.toContain(stalePair);
      expect(a.checkList.length).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  });

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
