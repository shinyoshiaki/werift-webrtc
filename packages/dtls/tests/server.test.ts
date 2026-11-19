import { HandshakeType } from "../src/handshake/const";
import { DtlsRandom } from "../src/handshake/random";
import {
  createClientHelloHandshake,
  createEcdsaDtlsServer,
  createHandshakeRecord,
  createLargeClientHelloHandshake,
  fragmentHandshake,
  sentHandshakeTypes,
} from "./utils";

describe("server", () => {
  test("handleFragmentHandshake", async () => {
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
      expect(server.cipher.remoteRandom.serialize()).toEqual(
        hello.fragment.subarray(2, 34),
      );
      await server.close();
    },
  );
});
