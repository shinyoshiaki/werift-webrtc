import { describe, expect, test } from "vitest";

import type { Transport } from "../../../../common/src";
import { DirectHandshakeCarrier } from "../../../src/carrier/direct";

function dummyTransport(): Transport {
  return {
    type: "dummy",
    address: { address: "127.0.0.1", port: 1, family: "IPv4" },
    closed: false,
    onData: () => {},
    send: async () => {},
    close: async () => {},
  };
}

describe("awaitable carrier inject", () => {
  test("inject はその datagram の handler 完了を待つ", async () => {
    // Arrange
    const carrier = new DirectHandshakeCarrier(dummyTransport());
    let released = false;
    carrier.setInjectHandler(async () => {
      await new Promise((r) => setTimeout(r, 30));
      released = true;
    });

    // Act
    await carrier.inject(Buffer.from([22, 1, 2, 3]), ["127.0.0.1", 1]);

    // Assert
    expect(released).toBe(true);
    carrier.close();
  });

  test("invalidateInboundInjects は待ち中の inject handler を走らせない", async () => {
    // Arrange
    const carrier = new DirectHandshakeCarrier(dummyTransport());
    let ran = false;
    carrier.setInjectHandler(async () => {
      ran = true;
    });

    // Act: inject が 1 tick 待つ間に inbound epoch を無効化する
    const pending = carrier.inject(Buffer.from([22, 1, 2, 3]), [
      "127.0.0.1",
      1,
    ]);
    carrier.invalidateInboundInjects();
    await pending;

    // Assert
    expect(ran).toBe(false);
    carrier.close();
  });
});
