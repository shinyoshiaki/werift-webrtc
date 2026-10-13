import {
  type DuplexSession,
  type InterruptWait,
  arrangeInterruptWait,
  assertNegotiationInvariants,
  assertTransportsClosed,
  expectSessionAlive,
  heldTransports,
  negotiate,
  prepareMutationAnswerer,
  negotiationTest as test,
  waitForCommittedNomination,
  waitForMutationSession,
} from "../harness/negotiationTransactionUtils";

/**
 * Interrupt injection (NEGOTIATION_TRANSACTION.md "Interrupts"): while a
 * negotiation waits on gathering, an mDNS lookup, the DTLS start or STUN
 * checks, the application closes the connection, requests an ICE restart,
 * starts a new offer or rolls the pending description back. The held
 * operation must settle, the invariants hold, a later clean negotiation
 * communicates, and close() leaves no transport running.
 */
type Interrupt = "close" | "restartIce" | "newOffer" | "rollback";

const cases: { wait: InterruptWait; interrupt: Interrupt }[] = (
  ["gather", "mdns", "dtls", "stun"] as const
).flatMap((wait) =>
  (["close", "restartIce", "newOffer", "rollback"] as const)
    // rollback は pending の description があるとき (restart pranswer 中) だけ。
    .filter((interrupt) => interrupt !== "rollback" || wait === "mdns")
    .map((interrupt) => ({ wait, interrupt })),
);

/** Act: start the interrupt (not awaited, the held operation is still running). */
function startInterrupt(session: DuplexSession, interrupt: Interrupt) {
  const { a } = session;
  switch (interrupt) {
    case "close":
      return a.pc.close();
    case "restartIce":
      a.pc.restartIce();
      return Promise.resolve();
    case "newOffer":
      return (async () => {
        await a.pc.setLocalDescription(await a.pc.createOffer());
      })();
    case "rollback":
      return a.pc.setLocalDescription({ type: "rollback" });
  }
}

/** Act: settle both peers back to stable from wherever the interrupt left them. */
async function settleToStable(session: DuplexSession) {
  const { a, b } = session;
  if (
    ["have-local-offer", "have-remote-pranswer"].includes(a.pc.signalingState)
  ) {
    await a.pc.setLocalDescription({ type: "rollback" });
  }
  if (b.pc.signalingState !== "stable") {
    await b.pc.setRemoteDescription({ type: "rollback" });
  }
}

/**
 * Assert: close() closes every transport the session held, including those
 * created midway (no leak).
 */
async function closeWithoutLeak(
  session: DuplexSession,
  transports: Set<unknown>,
) {
  for (const pc of [session.a.pc, session.b.pc]) {
    for (const transport of heldTransports(pc)) transports.add(transport);
  }
  await session.close();
  assertTransportsClosed(transports as Set<never>);
}

describe("negotiation transaction interrupts", () => {
  test.for(cases)(
    "$interrupt while waiting on $wait",
    async ({ wait, interrupt }, { closing }) => {
      // Arrange: wait の地点で止まった交渉を用意する。
      const held = await arrangeInterruptWait(wait);
      const session = closing(held.session);
      const transports = new Set<unknown>([
        ...heldTransports(session.a.pc),
        ...heldTransports(session.b.pc),
      ]);

      // Act: 待機中に割り込み、待機を解放する。
      const interrupted = startInterrupt(session, interrupt).then(
        () => "resolved",
        (error: Error) => error.name,
      );
      held.release();
      const [operation, interruption] = await Promise.race([
        Promise.all([held.pending, interrupted]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("interrupted wait hung")), 5000),
        ),
      ]);
      for (const transport of heldTransports(session.a.pc)) {
        transports.add(transport);
      }

      // Assert: 保留していた操作も割り込みも決着し、状態は一貫している。
      expect(["resolved", "InvalidStateError"]).toContain(operation);
      expect(["resolved", "InvalidStateError"]).toContain(interruption);
      if (interrupt === "close") {
        // close 後は closed のまま、どの transport も動いていない。
        expect(session.a.pc.signalingState).toBe("closed");
        assertTransportsClosed(heldTransports(session.a.pc));
        // Assert: close() は途中で作られたものを含め全 transport を閉じる (leak なし)。
        await closeWithoutLeak(session, transports);
        return;
      }
      assertNegotiationInvariants(session.a.pc);
      assertNegotiationInvariants(session.b.pc);

      // Act: 両 peer を stable に戻し、割り込みのない交渉をやり直す。
      await settleToStable(session);
      await negotiate(session, session.a, session.b, {
        beforeAnswer: () => prepareMutationAnswerer(session),
      });
      await waitForMutationSession(session);
      await Promise.all([
        waitForCommittedNomination(session.a.pc),
        waitForCommittedNomination(session.b.pc),
      ]);

      // Assert: やり直した session で双方向に通信できる。
      await expectSessionAlive(session, `${interrupt}-${wait}`);
      // Assert: close() は途中で作られたものを含め全 transport を閉じる (leak なし)。
      await closeWithoutLeak(session, transports);
    },
  );
});
