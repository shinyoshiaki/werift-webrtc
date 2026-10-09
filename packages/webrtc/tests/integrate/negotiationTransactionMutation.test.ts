import {
  type DuplexSession,
  MUTATION_NAMES,
  type MutationName,
  acceptOrRejectAtomically,
  assertTransportsClosed,
  breaksData,
  breaksMedia,
  createMutationSession,
  expectDataAlive,
  expectMediaAlive,
  heldTransports,
  misdescribesPeer,
  mutate,
  mutationPairs,
  negotiate,
  prepareMutationAnswerer,
  waitForMutationSession,
} from "./negotiationTransactionUtils";

/**
 * Peer-diversity SDP mutations (NEGOTIATION_TRANSACTION.md "Peer-diversity
 * mutations") applied on the wire to the offer, pranswer or answer of a first
 * negotiation and of a renegotiation. Every operation is accepted with the
 * invariants holding or rejected atomically; a rejected renegotiation keeps
 * the current session communicating, a clean final answer after a mutated
 * pranswer communicates, and the transports are closed after close().
 *
 * By default each mutation runs alone. WERIFT_NEGOTIATION_MUTATION=pairwise
 * runs every pair of mutations; =random:<count>:<seed> runs random
 * combinations of up to three.
 */
type Stage = "offer" | "pranswer" | "answer";
type Phase = "initial" | "renegotiation";

function combinations(): MutationName[][] {
  const mode = process.env.WERIFT_NEGOTIATION_MUTATION ?? "single";
  if (mode === "pairwise") return mutationPairs();
  if (mode.startsWith("random")) {
    const [, count = "50", seed = "1"] = mode.split(":");
    let state = Number(seed) >>> 0 || 1;
    const next = () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return state / 2 ** 32;
    };
    return Array.from({ length: Number(count) }, () => {
      const size = 1 + Math.floor(next() * 3);
      return Array.from(
        { length: size },
        () => MUTATION_NAMES[Math.floor(next() * MUTATION_NAMES.length)],
      );
    });
  }
  return MUTATION_NAMES.map((name) => [name]);
}

const cases = (["initial", "renegotiation"] as const).flatMap((phase) =>
  (["offer", "pranswer", "answer"] as const).flatMap((stage) =>
    combinations().map((mutations) => ({
      phase,
      stage,
      mutations,
      name: mutations.join("+"),
    })),
  ),
);

/**
 * Act: one negotiation from a to b whose `stage` description is mutated on
 * the wire. A pranswer stage is followed by the clean final answer. Returns
 * whether every operation was accepted, and whether a's final answer was
 * rejected after b had committed it (the peers then disagree).
 */
async function mutatedNegotiation(
  session: DuplexSession,
  stage: Stage,
  mutations: MutationName[],
) {
  const { a, b } = session;
  const wire = (at: Stage, sdp: string) =>
    at === stage ? mutate(sdp, mutations) : sdp;
  await a.pc.setLocalDescription(await a.pc.createOffer());
  // 変異した offer を b に適用する (受理か原子的な拒否)。
  const offerAccepted = await acceptOrRejectAtomically(session, () =>
    b.pc.setRemoteDescription({
      type: "offer",
      sdp: wire("offer", a.pc.localDescription!.sdp),
    }),
  );
  if (!offerAccepted) {
    await a.pc.setLocalDescription({ type: "rollback" });
    return { accepted: false, answerRejected: false };
  }
  await prepareMutationAnswerer(session);
  const answer = (await b.pc.createAnswer()).sdp;
  let accepted = true;
  if (stage === "pranswer") {
    // 変異した pranswer を a に適用し、その後に変異のない answer で確定する。
    await b.pc.setLocalDescription({ type: "pranswer", sdp: answer });
    accepted = await acceptOrRejectAtomically(session, () =>
      a.pc.setRemoteDescription({
        type: "pranswer",
        sdp: wire("pranswer", answer),
      }),
    );
  }
  await b.pc.setLocalDescription({ type: "answer", sdp: answer });
  const answerAccepted = await acceptOrRejectAtomically(session, () =>
    a.pc.setRemoteDescription({ type: "answer", sdp: wire("answer", answer) }),
  );
  if (!answerAccepted) {
    await a.pc.setLocalDescription({ type: "rollback" });
  }
  return {
    accepted: accepted && answerAccepted,
    answerRejected: !answerAccepted,
  };
}

describe("negotiation transaction SDP mutations", () => {
  let session: DuplexSession;

  afterEach(async () => {
    // Assert: close() は交渉で作った transport をすべて閉じる (leak なし)。
    const transports = new Set([
      ...heldTransports(session.a.pc),
      ...heldTransports(session.b.pc),
    ]);
    await session.close();
    assertTransportsClosed(transports);
  });

  test.each(cases)(
    "$phase $stage mutated by $name",
    async ({ phase, stage, mutations }) => {
      // Arrange: 初回交渉前の peer か、確立済みの session を用意する。
      session = await createMutationSession(phase);
      const label = `${phase}-${stage}-${mutations.join("+")}`;

      // Act: stage の description を wire 上で変異させて交渉する。
      const { accepted, answerRejected } = await mutatedNegotiation(
        session,
        stage,
        mutations,
      );

      // Assert: 両 peer は stable に戻る。
      expect(session.a.pc.signalingState).toBe("stable");
      expect(session.b.pc.signalingState).toBe("stable");

      // 変異を含む description がすべて受理された場合、変異が実際の peer と
      // 食い違わない限り、その session で通信できる。pranswer だけの変異は
      // 変異のない final answer で確定するので常に通信できる。
      const effective = stage === "pranswer" ? [] : mutations;
      if (accepted && !misdescribesPeer(effective)) {
        if (phase === "initial") await waitForMutationSession(session);
        if (!breaksMedia(effective)) await expectMediaAlive(session, label);
        if (!breaksData(effective)) await expectDataAlive(session, label);
      }
      // 拒否された再交渉は current session を壊さない。
      if (!accepted && phase === "renegotiation") {
        await expectMediaAlive(session, `${label}-rejected`);
        await expectDataAlive(session, `${label}-rejected`);
      }

      // Act: 変異のない再交渉を行う (変異を受理して peer と食い違ったときや、
      // b が確定した初回の answer を a が拒否したときは、両 peer の前提が
      // 異なるので行わない)。
      if (accepted && misdescribesPeer(effective)) return;
      if (phase === "initial" && answerRejected) return;
      await negotiate(session, session.a, session.b, {
        beforeAnswer: () => prepareMutationAnswerer(session),
      });
      if (phase === "initial" && !accepted) {
        await waitForMutationSession(session);
      }
      // Assert: 拒否後や素直な変異の後は、変異のない再交渉で通信できる。
      if (!(accepted && effective.includes("videoRejected"))) {
        await expectMediaAlive(session, `${label}-clean`);
      }
      if (!(accepted && breaksData(effective))) {
        await expectDataAlive(session, `${label}-clean`);
      }
    },
  );
});
