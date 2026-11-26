import { AlertDesc, AlertLevel, ContentType, type DtlsServer } from "../src";
import { HandshakeType } from "../src/handshake/const";
import { Alert } from "../src/handshake/message/alert";
import { DtlsRandom } from "../src/handshake/random";
import { createPlaintext } from "../src/record/builder";
import {
  createClientHelloHandshake,
  createEcdsaDtlsServer,
  createHandshakeRecord,
  createLargeClientHelloHandshake,
  createServerWithPartialHandshake,
  fragmentHandshake,
  sentHandshakeTypes,
  sentRecords,
  sliceHandshake,
} from "./utils";

describe("server", () => {
  test("handleFragmentHandshake returns a message only once every byte was received", async () => {
    // Arrange
    const { server } = await createEcdsaDtlsServer();
    const hello = createClientHelloHandshake({ random: new DtlsRandom() });
    const fragments = fragmentHandshake(hello, 10);
    const last = fragments.pop()!;
    const second = fragments.pop()!;

    // Act
    // 最後から 2 番目を抜いたまま末尾まで投入し、その後で抜いたフラグメントを投入する
    const beforeLast = fragments.flatMap((fragment) =>
      server.handleFragmentHandshake([fragment]),
    );
    const withGap = server.handleFragmentHandshake([last]);
    const completed = server.handleFragmentHandshake([second]);

    // Assert
    // 末尾が届いても欠落がある間は何も返らない
    expect(beforeLast).toEqual([]);
    expect(withGap).toEqual([]);
    // 全バイトがそろった時点で元と同じメッセージが 1 件だけ返る
    expect(completed).toHaveLength(1);
    expect(completed[0].serialize()).toEqual(hello.serialize());
    await server.close();
  });

  test.each([
    ["last, middle, first", [2, 1, 0]],
    ["middle, last, first", [1, 2, 0]],
  ])(
    "large ClientHello fragments in order [%s] get a HelloVerifyRequest",
    async (_, order) => {
      // Arrange
      const { server, transport } = await createEcdsaDtlsServer();
      const hello = createLargeClientHelloHandshake({
        random: new DtlsRandom(),
      });
      const fragments = fragmentHandshake(
        hello,
        Math.ceil(hello.length / 3),
        order,
      );

      // Act
      // 並べ替えた ClientHello フラグメントをレコードとしてサーバに受信させる
      fragments.forEach((fragment, sequenceNumber) =>
        transport.onData(
          createHandshakeRecord(fragment, { sequenceNumber }),
          undefined as any,
        ),
      );
      await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0));

      // Assert
      // 完全な ClientHello として処理され、HelloVerifyRequest が 1 回だけ送られる
      expect(sentHandshakeTypes(transport.sent)).toEqual([
        HandshakeType.hello_verify_request_3,
      ]);
      // cookie 検証前は association の暗号状態（remoteRandom）を確定しない
      expect(server.cipher.remoteRandom).toBeUndefined();
      await server.close();
    },
  );

  test.each([
    ["receiving a fatal alert", AlertLevel.fatal, AlertDesc.HandshakeFailure],
    ["receiving close_notify", AlertLevel.warning, AlertDesc.CloseNotify],
  ])(
    "frees partial handshake fragments when the connection ends by %s",
    async (_, level, description) => {
      // Arrange
      const { server, transport, reassembler } =
        await createServerWithPartialHandshake();
      expect(reassembler.size).toBe(1);
      const [packet] = createPlaintext(server.dtls)(
        [
          {
            type: ContentType.alert,
            fragment: new Alert(level, description).serialize(),
          },
        ],
        1,
      );

      // Act
      // 部分フラグメントを保持したまま、相手からの終了アラートを受信させる
      transport.onData(packet.serialize(), undefined as any);
      const sizeOnAlert = reassembler.size;
      await server.alertFlushed();

      // Assert
      // アラートを受信した時点で（応答の送信やトランスポートの close を待たずに）再構成バッファが解放される
      expect(sizeOnAlert).toBe(0);
      expect(reassembler.bufferedBytes).toBe(0);
      await server.close();
    },
  );

  test.each([
    [
      "sending a fatal alert",
      (server: DtlsServer) =>
        server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError),
    ],
    ["close()", (server: DtlsServer) => server.close()],
  ])(
    "frees partial handshake fragments when the connection ends by %s",
    async (_, end) => {
      // Arrange
      const { server, transport, reassembler } =
        await createServerWithPartialHandshake();
      expect(reassembler.size).toBe(1);

      // Act
      // 部分フラグメントを保持したまま、こちらから接続を終了する
      await end(server);

      // Assert
      // トランスポートが閉じられ、再構成バッファが解放される
      expect(transport.closed).toBe(true);
      expect(reassembler.size).toBe(0);
      expect(reassembler.bufferedBytes).toBe(0);
      await server.close();
    },
  );

  test("drops invalid and inconsistent handshake fragments without an alert", async () => {
    // Arrange
    const { server, transport } = await createEcdsaDtlsServer();
    const hello = createLargeClientHelloHandshake({ random: new DtlsRandom() });
    const half = Math.floor(hello.length / 2);
    const beyondLength = sliceHandshake(hello, hello.length - 10, hello.length);
    beyondLength.fragment_offset += 1;
    const corrupted = Buffer.from(hello.fragment.subarray(half, hello.length));
    corrupted[0] ^= 0xff;
    const injected = [
      beyondLength,
      sliceHandshake(hello, 0, half + 10),
      sliceHandshake(hello, half, hello.length, corrupted),
    ];
    const fragments = [
      ...injected,
      ...fragmentHandshake(hello, Math.ceil(hello.length / 3)),
    ];

    // Act
    // 長さを超えるフラグメントと、重なりのバイトが食い違うフラグメントを受信させてから、正しいフラグメントを受信させる
    fragments.forEach((fragment, sequenceNumber) =>
      transport.onData(
        createHandshakeRecord(fragment, { sequenceNumber }),
        undefined as any,
      ),
    );
    await vi.waitFor(() => expect(transport.sent.length).toBeGreaterThan(0));

    // Assert
    // 注入されたフラグメントではアラートを送らず接続も終わらず、正しい ClientHello に HelloVerifyRequest を返す
    expect(
      sentRecords(transport.sent).map((record) => record.contentType),
    ).toEqual([ContentType.handshake]);
    expect(sentHandshakeTypes(transport.sent)).toEqual([
      HandshakeType.hello_verify_request_3,
    ]);
    expect(transport.closed).toBe(false);
    await server.close();
  });
});
