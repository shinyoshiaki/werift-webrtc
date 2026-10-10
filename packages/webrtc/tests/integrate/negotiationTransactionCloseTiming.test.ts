import {
  CLOSE_TIMING_OPERATIONS,
  arrangeCloseTimingOperation,
  assertTransportsClosed,
  closeAfter,
  heldTransports,
  settlesWithin,
} from "./negotiationTransactionUtils";

/**
 * close() interrupts every public negotiation operation at every point of
 * its run: after 0..10 microtasks and after one macrotask. Whatever the
 * point, the operation's promise and a later operation's promise settle
 * (none stays pending forever), and every transport the peer held is closed.
 */
const TIMINGS = [...Array(11).keys(), "macrotask" as const];
const cases = CLOSE_TIMING_OPERATIONS.flatMap((operation) =>
  TIMINGS.map((ticks) => ({ operation, ticks })),
);

describe("close() at every point of a negotiation operation", () => {
  test.each(cases)(
    "$operation closed after $ticks",
    async ({ operation, ticks }) => {
      // Arrange: 操作に必要な状態の peer を用意する。
      const { pc, run, close } = await arrangeCloseTimingOperation(operation);
      try {
        // Act: 操作を始め、指定の時点で close() する。
        const pending = run();
        // 決着は下で検査する (close 前の reject を未処理扱いにしない)。
        pending.catch(() => undefined);
        await closeAfter(pc, ticks);

        // Assert: 操作の promise は決着する (永久に pending にならない)。
        // 失敗するなら close に追い越されたことを示す InvalidStateError。
        expect(await settlesWithin(pending, 3000)).toBe(true);
        const outcome = await pending.then(
          () => "resolved",
          (error: Error) => error.name,
        );
        expect(["resolved", "InvalidStateError"]).toContain(outcome);
        // Assert: close 後の操作も InvalidStateError で決着する。
        await expect(pc.createOffer()).rejects.toMatchObject({
          name: "InvalidStateError",
        });
        expect(pc.signalingState).toBe("closed");
        // Assert: 保持していた transport はすべて閉じている。
        assertTransportsClosed([
          ...heldTransports(pc),
          ...pc.getTransceivers().map((t) => t.dtlsTransport),
        ]);
      } finally {
        await close();
      }
    },
    15000,
  );
});
