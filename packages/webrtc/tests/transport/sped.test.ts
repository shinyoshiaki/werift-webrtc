import type { Connection } from "../../../ice/src";
import { CandidatePair } from "../../../ice/src";
import { Candidate } from "../../../ice/src/candidate";
import {
  type IceDatagramContext,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import { SpedSession } from "../../../ice/src/internal/sped";
import { SpedRuntime } from "../../../ice/src/sped/runtime";
import { IceSpedTransport } from "../../src/transport/sped";

function createIceStub(generation = 1, checkList: CandidatePair[] = []) {
  const sent: Buffer[] = [];
  const ice = {
    generation,
    nominated: undefined as CandidatePair | undefined,
    checkList,
    send: async (data: Buffer) => {
      sent.push(Buffer.from(data));
    },
    sent,
  };
  return ice as unknown as Connection & { sent: Buffer[] };
}

function dummySpedHooks() {
  return {
    inject: async () => {},
    onFallbackFlight: async () => {},
    setRetransmissionMode: () => {},
    updateRtt: () => {},
    resetRtt: () => {},
    setMtu: () => {},
  };
}

function mockProtocol(host: string, port: number) {
  const sent: { data: Buffer; addr?: [string, number] }[] = [];
  const protocol = {
    type: "udp",
    localCandidate: new Candidate("f", 1, "udp", 1, host, port, "host"),
    sendData: async (data: Buffer, addr?: [string, number]) => {
      sent.push({ data: Buffer.from(data), addr });
    },
  };
  return { protocol: protocol as any, sent };
}

function tcpProtocol(
  host: string,
  port: number,
  tcptype: "active" | "passive",
) {
  return {
    type: "tcp",
    localCandidate: new Candidate(
      tcptype,
      1,
      "tcp",
      1,
      host,
      port,
      "host",
      undefined,
      undefined,
      tcptype,
    ),
  } as any;
}

function authenticatedPair(
  protocol: any,
  host: string,
  port: number,
): CandidatePair {
  const transport = protocol.localCandidate?.transport ?? "udp";
  const pair = new CandidatePair(
    protocol,
    new Candidate("r", 1, transport, 1, host, port, "host"),
    true,
  );
  pair.requestsReceived = 1;
  return pair;
}

describe("IceSpedTransport datagram gate", () => {
  it("認証済み current-generation pair の DTLS だけ onData に渡す", () => {
    // Arrange
    const ice = createIceStub(2);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    const protocol = {
      type: "udp",
      localCandidate: new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    const dtls = Buffer.from([22, 1, 2, 3]);
    const allowed: IceDatagramContext = {
      bytes: dtls,
      source: ["9.9.9.9", 9],
      protocol,
      pair,
      generation: 2,
      authenticated: true,
    };

    // Act: 許可コンテキストのあと、不正 source / 未認証 / 非 DTLS を流す
    const datagram = connectionDatagramEvent(ice);
    datagram.execute(allowed);
    datagram.execute({
      ...allowed,
      source: ["8.8.8.8", 9],
    });
    datagram.execute({
      ...allowed,
      authenticated: false,
    });
    datagram.execute({
      ...allowed,
      bytes: Buffer.from([0x00, 0x01]),
    });

    // Assert: 条件を満たす DTLS 1 件だけ届く
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(dtls)).toBe(true);
  });

  it("WAITING でも requestsReceived がある認証済み pair の DTLS を渡す", () => {
    // Arrange: nomination 前・Binding Response 未受信の TCP/UDP 共通経路
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    const protocol = {
      type: "tcp",
      localCandidate: new Candidate("f", 1, "tcp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const pair = new CandidatePair(
      protocol,
      new Candidate("r", 1, "tcp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.requestsReceived = 1;
    const dtls = Buffer.from([22, 9, 8, 7]);

    // Act: ice.ts と同じ authenticated 条件を満たす datagram を流す
    connectionDatagramEvent(ice).execute({
      bytes: dtls,
      source: ["9.9.9.9", 9],
      protocol,
      pair,
      generation: 1,
      authenticated: true,
    });

    // Assert: pre-nomination の raw DTLS が IceSpedTransport に届く
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(dtls)).toBe(true);
  });

  it("handshake 完了後は nominated 以外の authenticated pair から application DTLS を渡さない", () => {
    // Arrange: restart 中。新 generation の pair は認証済みだが未 nomination
    const ice = createIceStub(2);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocol = {
      type: "udp",
      localCandidate: new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const pair = authenticatedPair(protocol, "9.9.9.9", 9);
    const app = Buffer.from([23, 1, 2, 3]);
    const ctx: IceDatagramContext = {
      bytes: app,
      source: ["9.9.9.9", 9],
      protocol,
      pair,
      generation: 2,
      authenticated: true,
    };

    // Act: 未 nomination のあと、同じ pair を selected にして再送する
    connectionDatagramEvent(ice).execute(ctx);
    ice.nominated = pair;
    connectionDatagramEvent(ice).execute(ctx);

    // Assert: nominated になるまで application record は届かない
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(app)).toBe(true);
  });

  it("handshake 完了後の ICE restart 中は pair も nominated も無い raw DTLS を渡さない", () => {
    // Arrange: nomination 前の restart window。未認証で pair も無い
    const ice = createIceStub(2);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocol = {
      type: "udp",
      localCandidate: new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const app = Buffer.from([23, 9, 9, 9]);

    // Act: undefined === undefined では通さない
    connectionDatagramEvent(ice).execute({
      bytes: app,
      source: ["8.8.8.8", 8],
      protocol,
      pair: undefined,
      generation: 2,
      authenticated: false,
    });

    // Assert: source/auth gate が nominated 比較より先に落とす
    expect(received).toHaveLength(0);
  });

  it("handshake 完了後は nominated pair でも source が remoteAddr と違う DTLS を渡さない", () => {
    // Arrange: pair object は nominated だが 5-tuple が違う
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocol = {
      type: "udp",
      localCandidate: new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const pair = authenticatedPair(protocol, "10.0.0.1", 1111);
    ice.nominated = pair;
    const app = Buffer.from([23, 8, 7, 6]);

    // Act: 同じ pair 参照のまま別 source から application record を流す
    connectionDatagramEvent(ice).execute({
      bytes: app,
      source: ["10.0.0.2", 2222],
      protocol,
      pair,
      generation: 1,
      authenticated: true,
    });

    // Assert: protocol 一致だけでは nominated 扱いにしない
    expect(received).toHaveLength(0);
  });

  it("handshake 完了後の UDP は nominated と異なる authenticated pair から application DTLS を渡さない", () => {
    // Arrange: nominated は pair A。B は認証済みだが別 candidate
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocolA = {
      type: "udp",
      localCandidate: new Candidate("f", 1, "udp", 1, "1.2.3.4", 1, "host"),
    } as any;
    const protocolB = {
      type: "udp",
      localCandidate: new Candidate("g", 1, "udp", 1, "1.2.3.4", 2, "host"),
    } as any;
    const pairA = authenticatedPair(protocolA, "10.0.0.1", 1111);
    const pairB = authenticatedPair(protocolB, "10.0.0.2", 2222);
    ice.nominated = pairA;
    const app = Buffer.from([23, 9, 8, 7]);
    const ctx: IceDatagramContext = {
      bytes: app,
      source: ["10.0.0.2", 2222],
      protocol: protocolB,
      pair: pairB,
      generation: 1,
      authenticated: true,
    };

    // Act: nominated ではない UDP pair から application record を流す
    connectionDatagramEvent(ice).execute(ctx);

    // Assert: UDP の別 candidate は nomination 後も届かない
    expect(received).toHaveLength(0);
  });

  it("handshake 完了後の TCP ICE は nominated local-active pair の application DTLS を渡す", () => {
    // Arrange
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocol = tcpProtocol("1.2.3.4", 1, "active");
    const pair = authenticatedPair(protocol, "9.9.9.9", 9);
    ice.nominated = pair;
    const app = Buffer.from([23, 1, 2, 3]);

    // Act: 選択された local-active TCP pair から application record を流す
    connectionDatagramEvent(ice).execute({
      bytes: app,
      source: ["9.9.9.9", 9],
      protocol,
      pair,
      generation: 1,
      authenticated: true,
    });

    // Assert: nominated TCP なら tcptype に依らず届く
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(app)).toBe(true);
  });

  it("handshake 完了後の TCP ICE は nominated local-passive pair の application DTLS を渡す", () => {
    // Arrange
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const protocol = tcpProtocol("1.2.3.4", 2, "passive");
    const pair = authenticatedPair(protocol, "9.9.9.9", 9);
    ice.nominated = pair;
    const app = Buffer.from([23, 4, 5, 6]);

    // Act: 選択された local-passive TCP pair から application record を流す
    connectionDatagramEvent(ice).execute({
      bytes: app,
      source: ["9.9.9.9", 9],
      protocol,
      pair,
      generation: 1,
      authenticated: true,
    });

    // Assert: nominated な local-passive も双方向なので届く
    expect(received).toHaveLength(1);
    expect(received[0]!.equals(app)).toBe(true);
  });

  it("handshake 完了後の TCP ICE は nominated 以外の authenticated pair から application DTLS を渡さない", () => {
    // Arrange: nominated は local-active。incoming は別 5-tuple の local-passive
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    transport.markApplicationReady();
    const activeProtocol = tcpProtocol("1.2.3.4", 1, "active");
    const passiveProtocol = tcpProtocol("1.2.3.4", 2, "passive");
    ice.nominated = authenticatedPair(activeProtocol, "9.9.9.9", 9);
    const otherPair = authenticatedPair(passiveProtocol, "8.8.8.8", 8);
    const app = Buffer.from([23, 7, 8, 9]);

    // Act: 同じ component の別 TCP pair から application record を流す
    connectionDatagramEvent(ice).execute({
      bytes: app,
      source: ["8.8.8.8", 8],
      protocol: passiveProtocol,
      pair: otherPair,
      generation: 1,
      authenticated: true,
    });

    // Assert: nominated と一致しない TCP pair は落とす
    expect(received).toHaveLength(0);
  });
});

describe("IceSpedTransport pre-nomination send", () => {
  it("pair A で association したあとの retransmit は candidate B に漏れない", async () => {
    // Arrange: 認証済み pair A/B。DTLS は A で開始
    const a = mockProtocol("1.2.3.4", 1000);
    const b = mockProtocol("5.6.7.8", 2000);
    const pairA = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const pairB = authenticatedPair(b.protocol, "10.0.0.2", 2222);
    const ice = createIceStub(1, [pairA, pairB]);
    const session = new SpedSession(1, "fallback");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    runtime.pinHandshakePath(pairA);
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    const hello = Buffer.from([22, 1, 2, 3]);

    // Act: B の Binding 相当で pin を試み、A 宛の内部 retransmit を送る
    runtime.pinHandshakePath(pairB);
    await transport.send(hello, pairA.remoteAddr);
    await transport.send(hello, pairB.remoteAddr);

    // Assert: wire は A のみ。B への明示 addr でも association を動かさない
    expect(runtime.lastPath).toBe(pairA);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.data.equals(hello)).toBe(true);
    expect(a.sent[0]!.addr).toEqual(["10.0.0.1", 1111]);
    expect(b.sent).toHaveLength(0);
  });

  it("carrier の明示 addr が認証済み pair と一致しないと送らない", async () => {
    // Arrange
    const a = mockProtocol("1.2.3.4", 1000);
    const pairA = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(1, [pairA]);
    const session = new SpedSession(1, "fallback");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    runtime.pinHandshakePath(pairA);
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);

    // Act: 未知の 5-tuple へ送ろうとする
    await transport.send(Buffer.from([22, 9]), ["8.8.8.8", 8]);

    // Assert: lastPath も動かさず wire に出さない
    expect(a.sent).toHaveLength(0);
    expect(runtime.lastPath).toBe(pairA);
  });

  it("handshake 完了後の ICE restart 中は nominated 無しでも protocol.sendData へ直接送らない", async () => {
    // Arrange: DataChannel 接続済み相当。restart で nominated が消え、新 generation の認証済み pair だけある
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(2, [pair]);
    ice.nominated = undefined;
    const session = new SpedSession(2, "complete");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    runtime.pinHandshakePath(pair);
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    transport.markApplicationReady();
    const app = Buffer.from([23, 1, 2, 3, 4]);

    // Act: nominated がまだ無い window で application data を送る
    await transport.send(app, pair.remoteAddr);

    // Assert: Connection.send へ任せ、pair.protocol.sendData には落とさない
    expect(a.sent).toHaveLength(0);
    expect(ice.sent).toHaveLength(1);
    expect(ice.sent[0]!.equals(app)).toBe(true);
  });
});
