import { UdpTransport } from "../src";

describe("UdpTransport send semantics", () => {
  test("IP send is fire-and-forget; sendAndWait awaits the kernel callback", async () => {
    // Arrange
    const t = await UdpTransport.init("udp4");
    let callbackInvoked = false;
    const orig = t.socket.send.bind(t.socket);
    t.socket.send = ((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const rest = args.slice(0, -1) as Parameters<typeof orig>;
        const ret = orig(...rest);
        setTimeout(() => {
          callbackInvoked = true;
          (last as (err: Error | null) => void)(null);
        }, 40);
        return ret;
      }
      return orig(...(args as Parameters<typeof orig>));
    }) as typeof t.socket.send;

    try {
      // Act: 解決済み IP への send は callback を待たない
      await t.send(Buffer.from("hot"), ["127.0.0.1", t.port]);
      // Assert
      expect(callbackInvoked).toBe(false);

      // Act: close_notify 用 flush は callback 完了を待つ
      const flushed = t.sendAndWait(Buffer.from("flush"), [
        "127.0.0.1",
        t.port,
      ]);
      expect(callbackInvoked).toBe(false);
      await flushed;
      expect(callbackInvoked).toBe(true);
    } finally {
      await t.close();
    }
  });
});
