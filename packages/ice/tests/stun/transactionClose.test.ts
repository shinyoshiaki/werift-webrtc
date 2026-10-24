import { setTimeout as delay } from "node:timers/promises";

import { TransactionCancelled } from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import {
  activeResourceCount,
  createLoopbackStunProtocol,
  holdLookup,
} from "../utils";

const bindingRequest = () => new Message(methods.BINDING, classes.REQUEST);

describe("STUN transactions end with their protocol", () => {
  test("close() rejects a request still waiting for a response and clears its retransmission timer", async () => {
    // Arrange: 応答のない宛先 (discard port) への request を待たせる。
    const protocol = await createLoopbackStunProtocol();
    const timersBefore = activeResourceCount("Timeout");
    const pending = protocol.request(bindingRequest(), ["127.0.0.1", 9]).then(
      () => undefined,
      (error: unknown) => error,
    );
    await delay(10);

    // Act: protocol を閉じる。
    await protocol.close();

    // Assert: request は TransactionCancelled で終わり、再送 timer も transaction も残らない。
    expect(await pending).toBeInstanceOf(TransactionCancelled);
    expect(protocol.transactionsKeys).toEqual([]);
    expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
  });

  test("a request whose DNS lookup finishes after close() starts no transaction", async () => {
    // Arrange: STUN server 名の lookup を止めた状態で request を始める。
    const lookup = holdLookup("127.0.0.1");
    const protocol = await createLoopbackStunProtocol();
    try {
      const timersBefore = activeResourceCount("Timeout");
      const pending = protocol
        .request(bindingRequest(), ["stun.invalid", 3478])
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      // Act: lookup の途中で protocol を閉じてから、lookup を終わらせる。
      await protocol.close();
      lookup.release();

      // Assert: 閉じた socket で transaction を始めず、timer も残さずに失敗する。
      expect(await pending).toBeInstanceOf(TransactionCancelled);
      expect(protocol.transactionsKeys).toEqual([]);
      expect(activeResourceCount("Timeout")).toBeLessThanOrEqual(timersBefore);
    } finally {
      lookup.restore();
    }
  });
});
