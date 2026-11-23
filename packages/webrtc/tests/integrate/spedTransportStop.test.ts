import { prepareSpedTransportStop } from "./warpArrange";

describe("SPED transport stop", () => {
  test.each([
    { name: "通常の停止", dtlsCloseFails: false },
    { name: "DTLS close が失敗する停止", dtlsCloseFails: true },
  ])(
    "$name: RTCDtlsTransport.stop() は SPED transport を閉じ、ICE datagram / state の購読を解放する",
    async ({ dtlsCloseFails }) => {
      // Arrange: 接続済み SPED セッションの SPED transport callback を監視する。
      const { offerer, answerer, transport, close, listeners, fireIceEvents } =
        await prepareSpedTransportStop({ dtlsCloseFails });
      try {
        // Act: transport を二重に停止し、停止完了後に ICE datagram / state を通知する。
        await transport.stop();
        await transport.stop();
        for (const listener of listeners) listener.mockClear();
        fireIceEvents();

        // Assert: stop() の完了時点で SPED transport は閉じられている。
        expect(close).toHaveBeenCalled();
        // Assert: 停止後の ICE 通知は SPED transport の callback へ届かない。
        for (const listener of listeners) {
          expect(listener).not.toHaveBeenCalled();
        }
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );
});
