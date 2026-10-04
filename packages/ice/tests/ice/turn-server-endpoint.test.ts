import { createSocket } from "node:dgram";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { type Address, TcpTransport } from "../../../common/src";
import { TransactionTimeout } from "../../src/exceptions";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TurnProtocol, createTurnClient } from "../../src/turn/protocol";
import { getHostAddresses } from "../../src/utils";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  canBindIpv6Loopback,
  createLocalTurnServer,
  createRecordingTransport,
  createStreamTurnServer,
  createTurnSuccessResponse,
  getLocalTurnClientTlsOptions,
  getLocalTurnServerTlsOptions,
  stubDualStackLookup,
  stubLookup,
  stubRotatingLookup,
} from "../utils";

const localTurnHost = getHostAddresses(true, false)[0]!;

const TURN_HOST = "turn.example.test";
/** An address the TURN server is not on: what a second lookup might answer. */
const OTHER_IPV4 = "192.0.2.99";
const credentials = {
  username: TURN_TEST_USERNAME,
  password: TURN_TEST_PASSWORD,
};

describe("TURN over TCP/TLS uses the peer the stream connected to", () => {
  let dns: ReturnType<typeof stubLookup>;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(() => {
    // A lookup of the configured hostname would answer a different address
    // than the one the stream connected to.
    dns = stubLookup(() => OTHER_IPV4);
  });

  afterEach(async () => {
    dns.restore();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  test.each(["tcp", "tls"] as const)(
    "%s allocates against the connected peer without a second lookup",
    async (transport) => {
      // Arrange: ホスト名 localhost で待ち受ける TCP/TLS の TURN サーバ
      const server = await createStreamTurnServer({ tls: transport === "tls" });
      cleanups.push(server.close);

      // Act: ホスト名を指定して TURN クライアントを作り Allocate する
      const turn = await createTurnClient(
        { address: ["localhost", server.port], ...credentials },
        { transport, tlsOptions: getLocalTurnClientTlsOptions() },
      );
      cleanups.push(() => turn.close());

      // Assert: 接続後に DNS を引き直さず、実際の接続先をサーバ端点としている
      expect(dns.families).toEqual([]);
      expect(turn.serverEndpoint).toEqual(["127.0.0.1", server.port]);
      expect(turn.serverEndpoint).toEqual(turn.transport.remoteAddress);
      // Assert: 接続先からの応答を受理して Allocate が完了している
      expect(turn.relayedAddress).toEqual(["198.51.100.1", 50000]);
    },
  );

  test("tls verifies the certificate against the configured hostname", async () => {
    // Arrange: TLS の TURN サーバと、検証したホスト名を記録するクライアント設定
    const server = await createStreamTurnServer({ tls: true });
    cleanups.push(server.close);
    const verifiedHosts: string[] = [];
    const tlsOptions = {
      ca: getLocalTurnServerTlsOptions().cert,
      checkServerIdentity: (host: string) => {
        verifiedHosts.push(host);
        return undefined;
      },
    };

    // Act: ホスト名を指定して TLS で接続する
    const turn = await createTurnClient(
      { address: ["localhost", server.port], ...credentials },
      { transport: "tls", tlsOptions },
    );
    cleanups.push(() => turn.close());

    // Assert: 証明書は解決済み IP ではなく設定したホスト名で検証されている
    expect(verifiedHosts).toEqual(["localhost"]);
  });

  test("a response from another address is ignored", async () => {
    // Arrange: 自動応答しない TCP サーバに接続し、Allocate を送らせる
    const server = await createStreamTurnServer({ respond: false });
    cleanups.push(server.close);
    const transport = await TcpTransport.init(["localhost", server.port]);
    const turn = new TurnProtocol(
      ["localhost", server.port],
      credentials.username,
      credentials.password,
      600,
      transport,
    );
    cleanups.push(() => turn.close());
    let settled = false;
    const allocation = turn.connectionMade().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    const response = createTurnSuccessResponse(server.requests[0]).bytes;

    // Act: 接続先とは別のアドレスから応答を届ける
    transport.onData(response, [OTHER_IPV4, server.port]);
    await setImmediate();

    // Assert: 別アドレスからの応答は受理されない
    expect(settled).toBe(false);

    // Act: 接続先から同じ応答を届ける
    transport.onData(response, transport.remoteAddress!);

    // Assert: 接続先からの応答で Allocate が完了する
    await expect(allocation).resolves.toBeUndefined();
  });

  test("a custom stream transport that reports its peer needs no lookup", async () => {
    // Arrange: remoteAddress を公開するカスタム TCP トランスポート
    const peer: Address = ["192.0.2.10", 3478];
    const recording = createRecordingTransport("tcp", { remoteAddress: peer });
    const turn = new TurnProtocol(
      [TURN_HOST, 3478],
      credentials.username,
      credentials.password,
      600,
      recording.transport,
    );

    // Act: Allocate を 1 回だけ送る
    await expect(
      turn.request(
        new Message(methods.ALLOCATE, classes.REQUEST),
        turn.server,
        undefined,
        { retransmissions: 0, responseTimeout: 5 },
      ),
    ).rejects.toBeInstanceOf(TransactionTimeout);

    // Assert: DNS を引かず、報告された接続先を宛先としている
    expect(dns.families).toEqual([]);
    expect(recording.sentTo).toEqual([peer]);
  });

  test("a custom stream transport without remoteAddress falls back to a lookup", async () => {
    // Arrange: remoteAddress を公開しないカスタム TCP トランスポート
    const recording = createRecordingTransport("tcp");
    const turn = new TurnProtocol(
      [TURN_HOST, 3478],
      credentials.username,
      credentials.password,
      600,
      recording.transport,
    );

    // Act: Allocate を 1 回だけ送る
    await expect(
      turn.request(
        new Message(methods.ALLOCATE, classes.REQUEST),
        turn.server,
        undefined,
        { retransmissions: 0, responseTimeout: 5 },
      ),
    ).rejects.toBeInstanceOf(TransactionTimeout);

    // Assert: 従来どおりファミリー指定なしで名前解決している
    expect(dns.families).toEqual([0]);
    expect(recording.sentTo).toEqual([[OTHER_IPV4, 3478]]);
  });
});

describe("TURN/UDP against a local TURN server", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function startTurnServer(host = localTurnHost) {
    const server = await createLocalTurnServer(host);
    cleanups.push(() => server.close());
    return server.address!;
  }

  async function startPeer() {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve) =>
      socket.bind(0, localTurnHost, () => resolve()),
    );
    cleanups.push(() => new Promise<void>((r) => socket.close(() => r())));
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));
    return {
      address: [localTurnHost, socket.address().port] as Address,
      received,
    };
  }

  test("an allocation keeps every operation on the first resolved endpoint", async () => {
    // Arrange: TURN サーバ、受信側ピア、2 回目以降は別アドレスを返す DNS
    const [host, port] = await startTurnServer();
    const peer = await startPeer();
    const dns = stubRotatingLookup(host, OTHER_IPV4);
    cleanups.push(() => dns.restore());

    // Act: Allocate する(401 の後に認証付きで再送される)
    const turn = await createTurnClient({
      address: [TURN_HOST, port],
      ...credentials,
    });
    cleanups.push(() => turn.close());
    const send = vi.spyOn(turn.transport, "send");

    // Act: ChannelBind に失敗させ、CreatePermission + Send indication で送る
    vi.spyOn(turn, "getChannel").mockRejectedValueOnce(new Error("no channel"));
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

    // Assert: 名前解決は最初の 1 回だけで、その端点に固定されている
    expect(dns.families).toEqual([4]);
    expect(turn.serverEndpoint).toEqual([host, port]);
    // Assert: Allocate 以降の送信はすべて固定した端点宛て
    const destinations = send.mock.calls.map(([, addr]) => addr);
    expect(destinations.length).toBeGreaterThanOrEqual(5);
    expect(destinations).toEqual(destinations.map(() => [host, port]));
    // Assert: どちらの経路のデータも TURN サーバ経由でピアに届いている
    await vi.waitFor(() =>
      expect(peer.received.sort()).toEqual([
        "via-channel-data",
        "via-send-indication",
      ]),
    );
  });

  test("a dual-stack hostname allocates over UDP without the retransmission timeout", async () => {
    // Arrange: AAAA を先に返すホスト名と、IPv4 で待ち受ける TURN サーバ
    const [host, port] = await startTurnServer();
    const dns = stubDualStackLookup(host, "2001:db8::1");
    cleanups.push(() => dns.restore());
    const started = performance.now();

    // Act: ホスト名を指定して UDP で Allocate する
    const turn = await createTurnClient({
      address: [TURN_HOST, port],
      ...credentials,
    });
    cleanups.push(() => turn.close());

    // Assert: IPv4 端点に UDP で割り当てられ、再送タイムアウトを待っていない
    expect(turn.transport.addressFamily).toBe(4);
    expect(turn.serverEndpoint).toEqual([host, port]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an IPv6 literal server gets a udp6 socket", async (context) => {
    // Arrange: IPv6 ループバックで待ち受ける TURN サーバ
    if (!(await canBindIpv6Loopback())) {
      context.skip();
    }
    const server = await startTurnServer("::1");

    // Act: IPv6 リテラルを指定して UDP で Allocate する
    const turn = await createTurnClient({ address: server, ...credentials });
    cleanups.push(() => turn.close());

    // Assert: udp6 ソケットで IPv6 の端点に割り当てられている
    expect(turn.transport.addressFamily).toBe(6);
    expect(turn.serverEndpoint).toEqual(server);
    expect(turn.relayedAddress[0]).toBe("::1");
  });

  test("an IPv6 literal in expanded notation allocates without the retransmission timeout", async (context) => {
    // Arrange: IPv6 ループバックの TURN サーバと、同じアドレスの展開表記
    if (!(await canBindIpv6Loopback())) {
      context.skip();
    }
    const [, port] = await startTurnServer("::1");
    const started = performance.now();

    // Act: 展開表記の IPv6 リテラルで Allocate する
    const turn = await createTurnClient({
      address: ["0:0:0:0:0:0:0:1", port],
      ...credentials,
    });
    cleanups.push(() => turn.close());

    // Assert: 送信元 ::1 の応答が破棄されず、再送タイムアウトを待たずに割り当てられる
    expect(turn.transport.addressFamily).toBe(6);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("an IPv4 literal server ignores udpFamily 6 and gets a udp4 socket", async () => {
    // Arrange: IPv4 で待ち受ける TURN サーバ
    const server = await startTurnServer();

    // Act: udpFamily: 6 と矛盾する IPv4 リテラルを指定して Allocate する
    const turn = await createTurnClient(
      { address: server, ...credentials },
      { udpFamily: 6 },
    );
    cleanups.push(() => turn.close());

    // Assert: リテラルが優先され、udp4 ソケットで IPv4 の端点に割り当てられている
    expect(turn.transport.addressFamily).toBe(4);
    expect(turn.serverEndpoint).toEqual(server);
  });

  test("an IPv6 literal server ignores udpFamily 4 and gets a udp6 socket", async (context) => {
    // Arrange: IPv6 ループバックで待ち受ける TURN サーバ
    if (!(await canBindIpv6Loopback())) {
      context.skip();
    }
    const server = await startTurnServer("::1");

    // Act: udpFamily: 4 と矛盾する IPv6 リテラルを指定して Allocate する
    const turn = await createTurnClient(
      { address: server, ...credentials },
      { udpFamily: 4 },
    );
    cleanups.push(() => turn.close());

    // Assert: リテラルが優先され、udp6 ソケットで IPv6 の端点に割り当てられている
    expect(turn.transport.addressFamily).toBe(6);
    expect(turn.serverEndpoint).toEqual(server);
  });

  test("udpFamily 6 resolves a hostname to its IPv6 address", async (context) => {
    // Arrange: IPv6 ループバックの TURN サーバと、デュアルスタックのホスト名
    if (!(await canBindIpv6Loopback())) {
      context.skip();
    }
    const [, port] = await startTurnServer("::1");
    const dns = stubDualStackLookup("127.0.0.1", "::1");
    cleanups.push(() => dns.restore());

    // Act: udpFamily: 6 でホスト名を指定して Allocate する
    const turn = await createTurnClient(
      { address: [TURN_HOST, port], ...credentials },
      { udpFamily: 6 },
    );
    cleanups.push(() => turn.close());

    // Assert: udp6 ソケットで IPv6 として名前解決している
    expect(turn.transport.addressFamily).toBe(6);
    expect(dns.families).toEqual([6]);
    expect(turn.serverEndpoint).toEqual(["::1", port]);
  });
});
