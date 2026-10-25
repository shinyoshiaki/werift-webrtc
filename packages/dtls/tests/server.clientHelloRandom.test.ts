import type { DtlsServer } from "../src";
import { DtlsRandom } from "../src/handshake/random";
import {
  createClientHelloHandshake,
  createEcdsaDtlsServer,
  findServerKeyExchange,
  verifyServerKeyExchangeSignature,
} from "./utils";

describe("server: ClientHello random after HelloVerifyRequest", () => {
  let server: DtlsServer | undefined;

  afterEach(() => {
    if (server) {
      // flight4 の再送ループを次のタイマーで終了させる
      server.dtls.flight = 6;
      server.close();
      server = undefined;
    }
  });

  /**flight1 (cookie なし) → flight3 (cookie あり) を投入し、flight4 送信直後の状態を返す */
  const handshakeUntilFlight4 = async (
    firstRandom: DtlsRandom,
    secondRandom: DtlsRandom,
  ) => {
    const arranged = await createEcdsaDtlsServer();
    server = arranged.server;

    // cookie なし ClientHello を受信して HelloVerifyRequest を返させる
    await server.onHandleHandshakes([
      createClientHelloHandshake({ random: firstRandom }),
    ]);
    const cookie = server.dtls.cookie!;
    arranged.transport.sent = [];

    // cookie 付き ClientHello を受信させる (flight4 の再送ループは await しない)
    void server.onHandleHandshakes([
      createClientHelloHandshake({ random: secondRandom, cookie }),
    ]);

    return { ...arranged, server, cookie };
  };

  test("same random in both ClientHellos", async () => {
    // Arrange
    const random = new DtlsRandom();

    // Act
    const { server, transport, certPem } = await handshakeUntilFlight4(
      random,
      random,
    );

    // Assert
    // flight4 が送信され、ServerKeyExchange が含まれている
    const keyExchange = findServerKeyExchange(transport.sent);
    expect(keyExchange).toBeDefined();
    // client_random は ClientHello の random のまま
    expect(server.cipher.remoteRandom.serialize()).toEqual(random.serialize());
    // ServerKeyExchange の署名がその random で検証できる
    expect(
      verifyServerKeyExchangeSignature({
        certPem,
        keyExchange: keyExchange!,
        clientRandom: random,
        serverRandom: server.cipher.localRandom,
      }),
    ).toBe(true);
  });
});
