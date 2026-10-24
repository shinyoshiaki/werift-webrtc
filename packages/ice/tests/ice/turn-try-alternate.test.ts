import { createSocket } from "node:dgram";
import { type Address, TcpTransport, UdpTransport } from "../../../common/src";
import { AddressFamilyMismatch, TurnRedirectError } from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import {
  TurnProtocol,
  createTurnClient,
  makeIntegrityKey,
} from "../../src/turn/protocol";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  alternateServerValue,
  appendStunAttributeBytes,
  createLocalTurnServer,
  createRecordingTransport,
  createStreamTurnRedirectServer,
  createTestConnection,
  createTurnSuccessResponse,
  createTurnTryAlternateResponse,
  createUdpTurnRedirectServer,
  getLocalTurnClientTlsOptions,
  getLocalTurnServerTlsOptions,
  localRelayCandidates,
  signStunMessageBytes,
  stunAttributeBytes,
} from "../utils";

const HOST = "127.0.0.1";
const credentials = {
  username: TURN_TEST_USERNAME,
  password: TURN_TEST_PASSWORD,
};

describe("TURN Allocate follows 300 (Try Alternate)", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function startTurnServer(options: { tls?: boolean } = {}) {
    const server = await createLocalTurnServer(HOST, options);
    cleanups.push(() => server.close());
    return server;
  }

  async function startUdpRedirector(alternate?: Address) {
    const redirector = await createUdpTurnRedirectServer({ alternate });
    cleanups.push(redirector.close);
    return redirector;
  }

  async function startPeer() {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, HOST, () => resolve()));
    cleanups.push(() => new Promise<void>((r) => socket.close(() => r())));
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));
    return { address: [HOST, socket.address().port] as Address, received };
  }

  describe("UDP", () => {
    test("allocates on ALTERNATE-SERVER after 401 authentication there", async () => {
      // Arrange: 実 TURN サーバと、そこへ 300 でリダイレクトするサーバ
      const alternate = await startTurnServer();
      const redirector = await startUdpRedirector(alternate.address!);

      // Act: リダイレクト元を設定して Allocate する
      const turn = await createTurnClient({
        address: redirector.address,
        ...credentials,
      });
      cleanups.push(() => turn.close());

      // Assert: リダイレクト元には未認証の Allocate が 1 回だけ届いている
      expect(redirector.requests).toHaveLength(1);
      expect(redirector.requests[0].messageMethod).toBe(methods.ALLOCATE);
      expect(redirector.requests[0].getAttributeValue("USERNAME")).toBe(
        undefined,
      );
      // Assert: allocation は alternate 上にあり、以後の宛先も alternate に固定される
      expect(turn.configuredServer).toEqual(redirector.address);
      expect(turn.server).toEqual(alternate.address);
      expect(turn.serverEndpoint).toEqual(alternate.address);
      // Assert: alternate の 401 を経て認証付き Allocate が成功し relay アドレスを得ている
      expect(turn.realm).toBe("werift.local");
      expect(turn.relayedAddress[0]).toBe(HOST);
    });

    test("Refresh, CreatePermission, ChannelBind and data go to the alternate", async () => {
      // Arrange: リダイレクト後に allocation を持つクライアントと受信側ピア
      const alternate = await startTurnServer();
      const redirector = await startUdpRedirector(alternate.address!);
      const peer = await startPeer();
      const turn = await createTurnClient({
        address: redirector.address,
        ...credentials,
      });
      cleanups.push(() => turn.close());
      const send = vi.spyOn(turn.transport, "send");

      // Act: ChannelBind に失敗させ CreatePermission + Send indication で送る
      vi.spyOn(turn, "getChannel").mockRejectedValueOnce(
        new Error("no channel"),
      );
      await turn.sendData(Buffer.from("via-send-indication"), peer.address);
      // Act: ChannelBind + ChannelData で送る
      await turn.sendData(Buffer.from("via-channel-data"), peer.address);
      // Act: Refresh する
      await turn.requestWithRetry(
        new Message(methods.REFRESH, classes.REQUEST).setAttribute(
          "LIFETIME",
          600,
        ),
        turn.server,
      );

      // Assert: すべての送信先が alternate で、リダイレクト元には何も追加で届かない
      expect(send.mock.calls.map(([, addr]) => addr)).not.toHaveLength(0);
      for (const [, addr] of send.mock.calls) {
        expect(addr).toEqual(alternate.address);
      }
      expect(redirector.requests).toHaveLength(1);
      // Assert: データは alternate の relay 経由でピアに届く
      await vi.waitFor(() =>
        expect(peer.received).toEqual([
          "via-send-indication",
          "via-channel-data",
        ]),
      );
    });

    test("ICE gathers a relay candidate through the redirect", async () => {
      // Arrange: リダイレクト元を TURN サーバとして設定した relay 専用 connection
      const alternate = await startTurnServer();
      const redirector = await startUdpRedirector(alternate.address!);
      const connection = createTestConnection(true, {
        stunServer: undefined,
        turnServer: redirector.address,
        turnUsername: TURN_TEST_USERNAME,
        turnPassword: TURN_TEST_PASSWORD,
        forceTurn: true,
      });
      cleanups.push(() => connection.close());

      // Act: 候補を収集する
      await connection.gatherCandidates();

      // Assert: alternate の relay アドレスで relay 候補が 1 つ得られる
      const relay = localRelayCandidates(connection);
      expect(relay).toHaveLength(1);
      expect(relay[0].host).toBe(HOST);
    });

    test("a redirect starts a fresh unauthenticated Allocate with the same credentials", async () => {
      // Arrange: 実ネットワークを使わずに送信内容を記録する UDP トランスポート
      const serverA: Address = ["192.0.2.1", 3478];
      const serverB: Address = ["192.0.2.2", 3478];
      const recording = createRecordingTransport("udp", { addressFamily: 4 });
      const turn = new TurnProtocol(
        serverA,
        credentials.username,
        credentials.password,
        600,
        recording.transport,
      );
      const keyA = makeIntegrityKey(
        credentials.username,
        "a.realm",
        credentials.password,
      );
      const keyB = makeIntegrityKey(
        credentials.username,
        "b.realm",
        credentials.password,
      );
      const sent = recording.sentMessages;
      // 送信済みリクエストを待ってから、それへの応答を返す
      const reply = async (
        from: Address,
        respond: (request: Message) => Message,
      ) => {
        const index = replied++;
        await vi.waitFor(() => expect(sent.length).toBeGreaterThan(index));
        recording.transport.onData(respond(sent[index]).bytes, from);
      };
      let replied = 0;
      const unauthorized =
        (realm: string, nonce: string) => (request: Message) =>
          new Message(methods.ALLOCATE, classes.ERROR, request.transactionId)
            .setAttribute("ERROR-CODE", [401, "Unauthorized"])
            .setAttribute("REALM", realm)
            .setAttribute("NONCE", Buffer.from(nonce));

      // Act: A で 401 認証を済ませた後、認証付き Allocate に 300 を返す
      const allocation = turn.connectionMade();
      await reply(serverA, unauthorized("a.realm", "nonce-a"));
      await reply(serverA, (request) =>
        createTurnTryAlternateResponse(request, { alternate: serverB })
          .addMessageIntegrity(keyA)
          .addFingerprint(),
      );
      // Act: B の未認証 Allocate に 401、認証付き Allocate に成功を返す
      await reply(serverB, unauthorized("b.realm", "nonce-b"));
      await reply(serverB, (request) =>
        createTurnSuccessResponse(request)
          .addMessageIntegrity(keyB)
          .addFingerprint(),
      );
      await allocation;
      await turn.close();

      // Assert: 送信先は A, A, B, B の順
      expect(recording.sentTo).toEqual([serverA, serverA, serverB, serverB]);
      // Assert: B への最初の Allocate は新しいトランザクション ID で、A の認証情報を含まない
      const ids = sent.map((m) => m.transactionIdHex);
      expect(new Set(ids).size).toBe(4);
      expect(sent[2].getAttributeValue("USERNAME")).toBe(undefined);
      expect(sent[2].getAttributeValue("NONCE")).toBe(undefined);
      expect(sent[2].getAttributeValue("MESSAGE-INTEGRITY")).toBe(undefined);
      // Assert: B への認証付き Allocate は同じユーザ名と B の realm / nonce を使う
      expect(sent[3].getAttributeValue("USERNAME")).toBe(credentials.username);
      expect(sent[3].getAttributeValue("REALM")).toBe("b.realm");
      expect(sent[3].getAttributeValue("NONCE")).toEqual(
        Buffer.from("nonce-b"),
      );
      expect(turn.relayedAddress).toEqual(["198.51.100.1", 50000]);
    });

    test("300 without ALTERNATE-SERVER fails without retrying and closes the client", async () => {
      // Arrange: ALTERNATE-SERVER を付けずに 300 を返すサーバ
      const redirector = await startUdpRedirector(undefined);
      const close = vi.spyOn(TurnProtocol.prototype, "close");

      // Act: Allocate する
      const allocation = createTurnClient({
        address: redirector.address,
        ...credentials,
      });

      // Assert: 認証失敗ではなく ALTERNATE-SERVER 欠落として失敗する
      await expect(allocation).rejects.toBeInstanceOf(TurnRedirectError);
      await expect(allocation).rejects.toMatchObject({
        reason: "missing-alternate",
      });
      // Assert: 再送せず、クライアントは閉じられている
      expect(redirector.requests).toHaveLength(1);
      expect(close).toHaveBeenCalledTimes(1);
    });

    test("a redirect back to the same server is rejected as a loop", async () => {
      // Arrange: 自分自身へリダイレクトするサーバ
      const redirector = await startUdpRedirector();
      redirector.target.alternate = redirector.address;

      // Act: Allocate する
      const allocation = createTurnClient({
        address: redirector.address,
        ...credentials,
      });

      // Assert: ループとして失敗し、同じサーバへ再送しない
      await expect(allocation).rejects.toMatchObject({ reason: "loop" });
      expect(redirector.requests).toHaveLength(1);
    });

    test("a ping-pong redirect A -> B -> A is rejected as a loop", async () => {
      // Arrange: 互いにリダイレクトし合う 2 つのサーバ
      const a = await startUdpRedirector();
      const b = await startUdpRedirector(a.address);
      a.target.alternate = b.address;

      // Act: A を設定して Allocate する
      const allocation = createTurnClient({
        address: a.address,
        ...credentials,
      });

      // Assert: B から A へ戻るリダイレクトはループとして拒否される
      await expect(allocation).rejects.toMatchObject({
        reason: "loop",
        server: b.address,
        alternate: a.address,
      });
      expect(a.requests).toHaveLength(1);
      expect(b.requests).toHaveLength(1);
    });

    test("more redirects than maxAllocateRedirects fail", async () => {
      // Arrange: A -> B -> C と連鎖するリダイレクトと、上限 1 回のクライアント
      const c = await startUdpRedirector(["127.0.0.1", 9]);
      const b = await startUdpRedirector(c.address);
      const a = await startUdpRedirector(b.address);
      const transport = await UdpTransport.init("udp4");
      const turn = new TurnProtocol(
        a.address,
        credentials.username,
        credentials.password,
        600,
        transport,
        { maxAllocateRedirects: 1 },
      );
      cleanups.push(() => turn.close());

      // Act: Allocate する
      const allocation = turn.connectionMade();

      // Assert: 2 回目のリダイレクトで回数超過として失敗し、C には送らない
      await expect(allocation).rejects.toMatchObject({
        reason: "too-many-redirects",
        server: b.address,
        alternate: c.address,
      });
      expect(c.requests).toHaveLength(0);
    });

    test("with IPv6 then IPv4 ALTERNATE-SERVERs, a udp4 client uses the IPv4 one", async () => {
      // Arrange: IPv6, IPv4 の順に ALTERNATE-SERVER を返すサーバと実 TURN サーバ
      const alternate = await startTurnServer();
      const redirector = await startUdpRedirector(["::1", 3478]);
      redirector.target.extraAlternates = [alternate.address!];

      // Act: IPv4 ソケットで Allocate する
      const turn = await createTurnClient({
        address: redirector.address,
        ...credentials,
      });
      cleanups.push(() => turn.close());

      // Assert: 到達可能な同一ファミリの候補(IPv4)で allocation できる
      expect(turn.server).toEqual(alternate.address);
      expect(turn.relayedAddress[0]).toBe(HOST);
    });

    test("with IPv4 then IPv6 ALTERNATE-SERVERs, a udp4 client uses the first IPv4", async () => {
      // Arrange: IPv4, IPv6 の順に ALTERNATE-SERVER を返すサーバ
      const alternate = await startTurnServer();
      const redirector = await startUdpRedirector(alternate.address!);
      redirector.target.extraAlternates = [["::1", 3478]];

      // Act: IPv4 ソケットで Allocate する
      const turn = await createTurnClient({
        address: redirector.address,
        ...credentials,
      });
      cleanups.push(() => turn.close());

      // Assert: 先頭の IPv4 候補が使われる
      expect(turn.server).toEqual(alternate.address);
    });

    test("a host name redirecting to its own resolved IP is rejected as a loop", async () => {
      // Arrange: localhost で設定され、解決後の自身の IP へリダイレクトするサーバ
      const redirector = await startUdpRedirector();
      redirector.target.alternate = redirector.address;

      // Act: ホスト名で設定して Allocate する
      const allocation = createTurnClient({
        address: ["localhost", redirector.address[1]],
        ...credentials,
      });

      // Assert: 再送せずにループとして失敗する
      await expect(allocation).rejects.toMatchObject({ reason: "loop" });
      expect(redirector.requests).toHaveLength(1);
    });

    test("an IPv6 ALTERNATE-SERVER cannot be reached from a udp4 socket", async () => {
      // Arrange: IPv6 の alternate を返すサーバ
      const redirector = await startUdpRedirector(["::1", 3478]);

      // Act: IPv4 ソケットで Allocate する
      const allocation = createTurnClient({
        address: redirector.address,
        ...credentials,
      });

      // Assert: アドレスファミリ不一致として失敗する
      await expect(allocation).rejects.toBeInstanceOf(AddressFamilyMismatch);
    });
  });

  describe("TCP/TLS", () => {
    test("tcp reconnects to the alternate and allocates there", async () => {
      // Arrange: 実 TURN サーバ(TCP)と、そこへ 300 でリダイレクトする TCP サーバ
      const alternate = await startTurnServer();
      const redirector = await createStreamTurnRedirectServer({
        alternate: alternate.address!,
      });
      cleanups.push(redirector.close);

      // Act: リダイレクト元へ TCP で Allocate する
      const turn = await createTurnClient(
        { address: redirector.address, ...credentials },
        { transport: "tcp" },
      );
      cleanups.push(() => turn.close());

      // Assert: 新しい TCP 接続で alternate に繋がり、401 認証を経て Allocate できている
      expect(redirector.requests).toHaveLength(1);
      expect(turn.transport.type).toBe("tcp");
      expect(turn.transport.remoteAddress).toEqual(alternate.address);
      expect(turn.serverEndpoint).toEqual(alternate.address);
      expect(turn.relayedAddress[0]).toBe(HOST);
    });

    test("tcp: a host name redirecting to its own resolved IP is rejected as a loop", async () => {
      // Arrange: localhost で設定され、解決後の自身の IP へリダイレクトする TCP サーバ
      const redirector = await createStreamTurnRedirectServer();
      cleanups.push(redirector.close);
      redirector.target.alternate = redirector.address;

      // Act: ホスト名で TCP 接続して Allocate する
      const allocation = createTurnClient(
        { address: ["localhost", redirector.address[1]], ...credentials },
        { transport: "tcp" },
      );

      // Assert: 再接続せずループとして失敗する
      await expect(allocation).rejects.toMatchObject({ reason: "loop" });
      expect(redirector.requests).toHaveLength(1);
    });

    test.each([
      ["ALTERNATE-DOMAIN", "alt.example.test", "alt.example.test"],
      ["the configured host", undefined, "localhost"],
    ])(
      "tls validates the alternate's certificate against %s",
      async (_label, alternateDomain, expectedIdentity) => {
        // Arrange: 実 TURN サーバ(TLS)、リダイレクトする TLS サーバ、検証名を記録する設定
        const alternate = await startTurnServer({ tls: true });
        const redirector = await createStreamTurnRedirectServer(
          { alternate: alternate.tlsAddress!, alternateDomain },
          { tls: true },
        );
        cleanups.push(redirector.close);
        const verifiedHosts: string[] = [];
        const tlsOptions = {
          ca: getLocalTurnServerTlsOptions().cert,
          checkServerIdentity: (host: string) => {
            verifiedHosts.push(host);
            return undefined;
          },
        };

        // Act: ホスト名でリダイレクト元を設定し TLS で Allocate する
        const turn = await createTurnClient(
          { address: ["localhost", redirector.port], ...credentials },
          { transport: "tls", tlsOptions },
        );
        cleanups.push(() => turn.close());

        // Assert: 元サーバは設定ホスト名、alternate は期待する名前で検証されている
        expect(verifiedHosts).toEqual(["localhost", expectedIdentity]);
        // Assert: alternate 上で Allocate が完了している
        expect(turn.transport.remoteAddress).toEqual(alternate.tlsAddress);
        expect(turn.relayedAddress[0]).toBe(HOST);
      },
    );

    test("a stream transport without reconnect fails clearly", async () => {
      // Arrange: reconnect を渡さずに TurnProtocol を直接使う TCP クライアント
      const redirector = await createStreamTurnRedirectServer({
        alternate: ["127.0.0.1", 9],
      });
      cleanups.push(redirector.close);
      const transport = await TcpTransport.init(redirector.address);
      const turn = new TurnProtocol(
        redirector.address,
        credentials.username,
        credentials.password,
        600,
        transport,
      );
      cleanups.push(() => turn.close());

      // Act: Allocate する
      const allocation = turn.connectionMade();

      // Assert: stream リダイレクト未対応として失敗する
      await expect(allocation).rejects.toMatchObject({
        reason: "unsupported-transport",
      });
    });
  });
});

describe("TURN Allocate without a redirect", () => {
  test("tls uses the original connection when no 300 is returned", async () => {
    // Arrange: 通常の TLS TURN サーバ
    const server = await createLocalTurnServer(HOST, { tls: true });
    try {
      // Act: Allocate する
      const turn = await createTurnClient(
        { address: server.tlsAddress!, ...credentials },
        { transport: "tls", tlsOptions: getLocalTurnClientTlsOptions() },
      );

      // Assert: 設定どおりのサーバ上で allocation が作られている
      expect(turn.server).toEqual(turn.configuredServer);
      expect(turn.serverEndpoint).toEqual(server.tlsAddress);
      await turn.close();
    } finally {
      await server.close();
    }
  });
});

describe("STUN parsing ignores attributes after MESSAGE-INTEGRITY", () => {
  const key = Buffer.from("integrity-key");
  const errorCode = (code: number) =>
    Buffer.from([0, 0, Math.floor(code / 100), code % 100]);

  test("an appended ERROR-CODE 300 and ALTERNATE-SERVER do not turn a signed 403 into a redirect", () => {
    // Arrange: 署名済みの 403 応答に、署名範囲外として 300 と ALTERNATE-SERVER を追記する
    const signed = signStunMessageBytes(
      new Message(methods.ALLOCATE, classes.ERROR).setAttribute("ERROR-CODE", [
        403,
        "Forbidden",
      ]),
      key,
    );
    const forged = appendStunAttributeBytes(
      appendStunAttributeBytes(
        signed,
        stunAttributeBytes(0x0009, errorCode(300)),
      ),
      stunAttributeBytes(0x8023, alternateServerValue(["192.0.2.1", 3478])),
    );

    // Act: 署名鍵付きで解析する(HMAC は署名範囲だけを見るので検証は通る)
    const parsed = parseMessage(forged, key);

    // Assert: 追記分は無視され、403 のままで alternate も存在しない
    expect(parsed).toBeDefined();
    expect(parsed!.getAttributeValue("ERROR-CODE")![0]).toBe(403);
    expect(parsed!.alternateServers).toEqual([]);
    expect(parsed!.getAttributeValue("ALTERNATE-SERVER")).toBeUndefined();
  });

  test("FINGERPRINT after MESSAGE-INTEGRITY is still parsed", () => {
    // Arrange: 署名後に FINGERPRINT が付いた応答
    const message = new Message(methods.ALLOCATE, classes.ERROR)
      .setAttribute("ERROR-CODE", [403, "Forbidden"])
      .addMessageIntegrity(key)
      .addFingerprint();

    // Act: 解析する
    const parsed = parseMessage(message.bytes, key);

    // Assert: FINGERPRINT は例外として扱われ、メッセージは有効
    expect(parsed?.getAttributeValue("FINGERPRINT")).toBeDefined();
  });

  test("several signed ALTERNATE-SERVERs are all kept in wire order", () => {
    // Arrange: 署名範囲内に IPv6, IPv4 の順で ALTERNATE-SERVER を持つ 300 応答
    const message = new Message(methods.ALLOCATE, classes.ERROR)
      .setAttribute("ERROR-CODE", [300, "Try Alternate"])
      .setAttribute("ALTERNATE-SERVER", ["2001:db8::1", 3478])
      .appendRawAttribute(0x8023, alternateServerValue(["192.0.2.1", 3478]));
    const signed = signStunMessageBytes(message, key);

    // Act: 署名鍵付きで解析する
    const parsed = parseMessage(signed, key);

    // Assert: 両方の alternate が順序どおりに残る
    expect(parsed?.alternateServers).toEqual([
      ["2001:db8::1", 3478],
      ["192.0.2.1", 3478],
    ]);
  });
});
