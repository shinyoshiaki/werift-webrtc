import { HandshakeType } from "../../src/handshake/const";
import {
  connectDtlsPair,
  createDtlsPair,
  createRefragmentingImpairment,
} from "../utils";

describe("e2e/fragment: handshake over a reordering, lossy transport", () => {
  let pair: ReturnType<typeof createDtlsPair> | undefined;

  afterEach(async () => {
    await Promise.all([pair?.client.close(), pair?.server.close()]);
    pair = undefined;
  });

  test.each([
    [
      "with the first fragment last",
      { reverseOrder: false, firstFragmentLast: true, duplicate: false },
    ],
    [
      "with the first fragment last, duplicated",
      { reverseOrder: false, firstFragmentLast: true, duplicate: true },
    ],
    [
      "reversed",
      { reverseOrder: true, firstFragmentLast: false, duplicate: false },
    ],
  ])(
    "every handshake message fragmented and %s, first ClientHello fragment lost",
    async (_, { reverseOrder, firstFragmentLast, duplicate }) => {
      // Arrange
      pair = createDtlsPair();
      pair.clientTransport.reverseOrder = reverseOrder;
      pair.serverTransport.reverseOrder = reverseOrder;
      pair.serverTransport.impair = createRefragmentingImpairment({
        maxFragmentLength: 64,
        firstFragmentLast,
        duplicate,
      });
      pair.clientTransport.impair = createRefragmentingImpairment({
        maxFragmentLength: 64,
        firstFragmentLast,
        duplicate,
        // 初回 ClientHello の先頭フラグメントを落として再送させる
        dropOnce: (fragment) =>
          fragment.msg_type === HandshakeType.client_hello_1 &&
          fragment.fragment_offset === 0,
      });
      const received = pair.server.onData.asPromise();
      const replied = pair.client.onData.asPromise();
      pair.server.onData.subscribe((data) =>
        pair?.server.send(Buffer.concat([data, Buffer.from("_server")])),
      );

      // Act
      // 全ハンドシェイクメッセージを 64 バイト以下に分割し、並べ替え・重複・欠落を起こす経路で接続し、データを往復させる
      await connectDtlsPair(pair);
      await pair.client.send(Buffer.from("ping"));
      const [[atServer], [atClient]] = await Promise.all([received, replied]);

      // Assert
      // 再送を経てハンドシェイクが完了し、アプリケーションデータが往復する
      expect(pair.client.connected).toBe(true);
      expect(pair.server.connected).toBe(true);
      expect(atServer.toString()).toBe("ping");
      expect(atClient.toString()).toBe("ping_server");
    },
    15_000,
  );
});
