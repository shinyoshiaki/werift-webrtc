import { createLoopbackStunProtocol } from "../utils";

describe("StunProtocol transport errors", () => {
  test("a UDP socket error does not escape as an uncaught exception", async () => {
    // Arrange: loopback に bind した StunProtocol を用意する。
    const protocol = await createLoopbackStunProtocol();
    const error = Object.assign(new Error("recvmsg ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    try {
      // Act: Bun が ICMP port unreachable で出す error 相当を socket に emit する。
      const emit = () => protocol.transport.socket.emit("error", error);

      // Assert: 例外にならず、transport は開いたまま使える。
      expect(emit).not.toThrow();
      expect(protocol.transport.closed).toBe(false);
    } finally {
      await protocol.close();
    }
  });
});
