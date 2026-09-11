import { vi } from "vitest";
import {
  CandidatePair,
  CandidatePairState,
  Connection,
} from "../../../ice/src";
import { Candidate } from "../../../ice/src/candidate";
import {
  type IceDatagramContext,
  connectionDatagramEvent,
} from "../../../ice/src/internal/datagram";
import { SpedSession } from "../../../ice/src/internal/sped";
import { SpedRuntime } from "../../../ice/src/sped/runtime";
import type { Protocol } from "../../../ice/src/types/model";
import { Event, flushTransportSend } from "../../src/imports/common";
import { IceSpedTransport } from "../../src/transport/sped";

function createIceStub(generation = 1, checkList: CandidatePair[] = []) {
  const sent: Buffer[] = [];
  const ice = {
    generation,
    nominated: undefined as CandidatePair | undefined,
    checkList,
    state: "connected" as string,
    applicationDataReady: false,
    stateChanged: new Event<[string]>(),
    canSendApplicationData: () =>
      ice.applicationDataReady && ice.nominated !== undefined,
    send: async (data: Buffer) => {
      if (!ice.canSendApplicationData()) {
        return;
      }
      sent.push(Buffer.from(data));
    },
    sent,
  };
  return ice as unknown as Connection & {
    sent: Buffer[];
    applicationDataReady: boolean;
    stateChanged: Event<[string]>;
  };
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
  pair.updateState(CandidatePairState.SUCCEEDED);
  return pair;
}

function protocolWithEvents(host: string, port: number): Protocol {
  return {
    type: "udp",
    onRequestReceived: new Event(),
    onDataReceived: new Event(),
    localCandidate: new Candidate("f", 1, "udp", 1, host, port, "host"),
    request: async () => null as never,
    sendStun: async () => {},
    sendData: async () => {},
    connectionMade: async () => {},
    close: async () => {},
  };
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

  it("source 無しの onDataReceived は認証済み nominated pair でも DTLS に渡さない", () => {
    // Arrange: public Protocol が source を省略して発火する
    const ice = new Connection(true);
    const transport = new IceSpedTransport(ice);
    const received: Buffer[] = [];
    transport.onData = (buf) => {
      received.push(buf);
    };
    const protocol = protocolWithEvents("1.2.3.4", 1);
    (
      ice as unknown as { ensureProtocol: (protocol: Protocol) => void }
    ).ensureProtocol(protocol);
    const pair = authenticatedPair(protocol, "9.9.9.9", 9);
    pair.nominated = true;
    ice.checkList.push(pair);
    ice.nominated = pair;
    const dtls = Buffer.from([22, 1, 2, 3]);

    // Act: source 無しのあと、同じ bytes を pair の remote 5-tuple 付きで流す
    protocol.onDataReceived.execute(dtls);
    protocol.onDataReceived.execute(dtls, pair.remoteAddr);

    // Assert: source が無い datagram は DTLS に入れず、明示 source だけ通す
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
  it("writeReady application data bypasses SPED embedding on the authenticated pair", async () => {
    // Arrange: SPED active 中で nomination 前の認証済み pair を用意する。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(1, [pair]);
    const session = new SpedSession(1, "active");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    runtime.pinHandshakePath(pair);
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    const app = Buffer.from([23, 1, 2, 3, 4]);

    // Act: server Finished 後と同じ writeReady permission で application record を送る。
    transport.markApplicationWriteReady();
    await transport.send(app, pair.remoteAddr);

    // Assert: handshake embedding 中でも protected application data は wire へ出る。
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.data.equals(app)).toBe(true);
    expect(a.sent[0]!.addr).toEqual(pair.remoteAddr);
  });

  it("hybrid direct-ready 中の handshake record は固定 pair へ raw 送信する", async () => {
    // Arrange: embedding 中でも handshake-only direct を許可する。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(1, [pair]);
    ice.generation = 1;
    const session = new SpedSession(1, "active");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    const hello = Buffer.from([22, 1, 2, 3]);

    // Act: 通知された pair へ type 22 を送る
    transport.enableHandshakeDirect(pair, 1);
    await transport.send(hello, pair.remoteAddr);

    // Assert: session.embedding でも handshake control は固定 pair の sendData に出る
    expect(session.embedding).toBe(true);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.data.equals(hello)).toBe(true);
    expect(a.sent[0]!.addr).toEqual(pair.remoteAddr);
  });

  it("hybrid direct-ready でも sendApplication は fingerprint gate を迂回しない", async () => {
    // Arrange: handshake direct は開いているが application writeReady は未設定。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(1, [pair]);
    ice.generation = 1;
    const session = new SpedSession(1, "active");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    const app = Buffer.from([23, 9, 8, 7]);

    // Act: application record を handshake permission だけで送ろうとする
    transport.enableHandshakeDirect(pair, 1);
    await transport.sendApplication(app, pair.remoteAddr);

    // Assert: embedding 中の app/media は Direct handshake path を使わない
    expect(session.embedding).toBe(true);
    expect(a.sent).toHaveLength(0);
  });

  it("writeReady の未認証 pair への application data は認証後に wire へ送る", async () => {
    // Arrange: pair は checklist に存在するが、Binding 認証と nomination を遅延させる。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = new CandidatePair(
      a.protocol,
      new Candidate("r", 1, "udp", 1, "10.0.0.1", 1111, "host"),
      true,
    );
    const ice = createIceStub(1, [pair]);
    const transport = new IceSpedTransport(ice);
    const app = Buffer.from([23, 7, 6, 5]);
    transport.markApplicationWriteReady();

    try {
      // Act: pair 未認証の間に送信を開始し、wire へはまだ出ないことを確認する。
      const pendingSend = transport.send(app, pair.remoteAddr);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(a.sent).toHaveLength(0);

      // Act: nomination 前のまま Binding 認証だけを成立させ、datagram event で drain する。
      pair.requestsReceived = 1;
      connectionDatagramEvent(ice).execute({
        bytes: Buffer.from([0, 1]),
        source: pair.remoteAddr,
        protocol: a.protocol,
        pair,
        generation: ice.generation,
        authenticated: true,
      });
      await pendingSend;

      // Assert: send() は成功扱いのまま捨てず、認証済み pair の wire へ一度だけ届く。
      expect(a.sent).toHaveLength(1);
      expect(a.sent[0]!.data.equals(app)).toBe(true);
      expect(a.sent[0]!.addr).toEqual(pair.remoteAddr);
    } finally {
      await transport.close();
    }
  });

  it("writeReady uses nominated pair directly before ICE consent permits Connection.send", async () => {
    // Arrange: nomination 済みだが consent 前の full ICE window を再現する。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    pair.nominated = true;
    const ice = createIceStub(1, [pair]);
    ice.nominated = pair;
    const session = new SpedSession(1, "active");
    const runtime = new SpedRuntime(session, dummySpedHooks());
    runtime.pinHandshakePath(pair);
    const transport = new IceSpedTransport(ice);
    transport.setRuntime(runtime);
    transport.markApplicationWriteReady();
    const earlyMedia = Buffer.from([23, 5, 6, 7]);

    // Act: server writeReady 直後の protected media を送る。
    await transport.send(earlyMedia);

    // Assert: consent gate のある Connection.send ではなく認証済み pair を使う。
    expect(ice.sent).toHaveLength(0);
    expect(a.sent).toHaveLength(1);
    expect(a.sent[0]!.data.equals(earlyMedia)).toBe(true);
    expect(a.sent[0]!.addr).toEqual(pair.remoteAddr);
  });

  it("ICE failed 後は writeReady の direct pair 送信を拒否する", async () => {
    // Arrange: writeReady と認証済み pair があっても ICE を terminal にする。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    const ice = createIceStub(1, [pair]);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationWriteReady();
    ice.state = "failed";
    ice.stateChanged.execute("failed");

    try {
      // Act: 失効した consent 経路へ direct early application data を送る。
      const send = transport.send(Buffer.from([23, 9, 8, 7]), pair.remoteAddr);

      // Assert: failed 経路は pair が残っていても wire へ到達させない。
      await expect(send).rejects.toThrow(/ICE failed/);
      expect(a.sent).toHaveLength(0);
    } finally {
      await transport.close();
    }
  });

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

  it("handshake 完了後は nomination/consent 前の application data を wire へ送らない", async () => {
    // Arrange: DTLS 完了済みだが、ICE restart 直後で selected pair と consent が無い
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

    // Act: nominated がまだ無い window で application data を保留する
    await transport.send(app, pair.remoteAddr);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert: Connection.send の no-op 成功を wire 送信と誤認しない
    expect(a.sent).toHaveLength(0);

    // Act: nomination と consent を成立させ、Connection の readiness 通知を発火する
    ice.nominated = pair;
    ice.applicationDataReady = true;
    ice.stateChanged.execute("connected");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Assert: 実際に送信可能になった後だけ wire へ一度届く
    expect(ice.sent).toHaveLength(1);
    expect(ice.sent[0]!.equals(app)).toBe(true);
  });

  it("実 Connection.send の no-op 成功を nomination 後の wire 送信まで保留する", async () => {
    // Arrange: 実 Connection を使い、DTLS 完了後・ICE nomination 前の状態を作る。
    const ice = new Connection(true, { iceLite: true });
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = authenticatedPair(a.protocol, "10.0.0.1", 1111);
    ice.checkList.push(pair);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationReady();
    const app = Buffer.from([23, 4, 3, 2, 1]);

    try {
      // Act: nomination 前の Connection.send が no-op になる期間に送信を要求する。
      let completed = false;
      const pendingSend = transport.sendMediaAndWait(app).then(() => {
        completed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Assert: wire 到達を待つ Promise は未完了で、wire にもまだ出ない。
      expect(completed).toBe(false);
      expect(a.sent).toHaveLength(0);

      // Act: 実 Connection の selected pair を確定し、待機 queue を再開する。
      ice.nominated = pair;
      ice.state = "connected";
      ice.stateChanged.execute("connected");
      await pendingSend;

      // Assert: 実 Connection.send が送信可能になった後だけ wire に届く。
      expect(a.sent).toHaveLength(1);
      expect(a.sent[0]!.data.equals(app)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  it("ICE failed 後に application media queue を作らない", async () => {
    // Arrange: application-ready だが、ICE はすでに terminal state にする。
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationReady();
    ice.state = "failed";
    ice.stateChanged.execute("failed");

    try {
      // Act: failed 通知後と同じ状態で wire 到達待ちの media を送る。
      const send = transport.sendMediaAndWait(Buffer.from([23, 1, 2, 3]));

      // Assert: 待機を残さず、呼び出し元へ失敗を返す。
      await expect(send).rejects.toThrow(/ICE failed/);
      expect(
        (transport as unknown as { pendingEarlySends: unknown[] })
          .pendingEarlySends,
      ).toHaveLength(0);
      expect(
        (transport as unknown as { earlySendRetryTimer?: unknown })
          .earlySendRetryTimer,
      ).toBeUndefined();
    } finally {
      await transport.close();
    }
  });

  it("ICE の送信経路喪失中に application media の待機を期限切れにする", async () => {
    // Arrange: ICE は connected のままだが、nomination/consent が失われた状態にする。
    vi.useFakeTimers();
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationReady();

    try {
      // Act: wire 到達を待つ media を要求し、期限前の未完了を確認する。
      let settled = false;
      const outcome = transport
        .sendMediaAndWait(Buffer.from([23, 4, 5, 6]))
        .then(
          () => {
            settled = true;
            return "resolved" as const;
          },
          (error) => {
            settled = true;
            return error;
          },
        );
      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);

      // Assert: 経路が復旧しない場合も期限内に reject し、queue/timer を残さない。
      await vi.advanceTimersByTimeAsync(1);
      const result = await outcome;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/timed out/);
      expect(
        (transport as unknown as { pendingEarlySends: unknown[] })
          .pendingEarlySends,
      ).toHaveLength(0);
    } finally {
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("flush 前に retention が切れた application data は timer 未実行でも送らない", async () => {
    // Arrange: application-ready だが経路のない transport と、期限待ちの送信を用意する。
    vi.useFakeTimers();
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationReady();
    const staleApplication = Buffer.from([23, 0xaa, 0xbb]);

    try {
      // Act: Connection.send が no-op になる経路で queue を作る。
      await transport.send(staleApplication);
      await Promise.resolve();
      const pending = (
        transport as unknown as {
          pendingEarlySends: { expiresAt?: number }[];
          flushPendingEarlySends(): void;
        }
      ).pendingEarlySends;
      expect(pending).toHaveLength(1);
      const expiresAt = pending[0]!.expiresAt!;

      // Act: expiry timer は実行せず、時計だけを期限後へ進めて先に flush する。
      vi.setSystemTime(expiresAt + 1);
      const pair = authenticatedPair(
        mockProtocol("1.2.3.4", 1000).protocol,
        "10.0.0.1",
        1111,
      );
      ice.nominated = pair;
      ice.applicationDataReady = true;
      (
        transport as unknown as { flushPendingEarlySends(): void }
      ).flushPendingEarlySends();
      await Promise.resolve();

      // Assert: flush 側の期限検証で失敗し、期限切れ packet は wire へ出ない。
      expect(
        (transport as unknown as { pendingEarlySends: unknown[] })
          .pendingEarlySends,
      ).toHaveLength(0);
      expect(ice.sent).toHaveLength(0);
    } finally {
      await transport.close();
      vi.useRealTimers();
    }
  });

  it("early application policy を取り消しても DTLS control queue は保持する", async () => {
    // Arrange: writeReady 後だが認証済み pair がまだ無い transport に control/application を積む。
    const a = mockProtocol("1.2.3.4", 1000);
    const pair = new CandidatePair(
      a.protocol,
      new Candidate("r", 1, "udp", 1, "10.0.0.1", 1111, "host"),
      true,
    );
    const ice = createIceStub(1, [pair]);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationWriteReady();
    const control = Buffer.from([22, 1, 2, 3]);
    const directControl = Buffer.from([20, 9, 8, 7]);
    // DTLS 1.3 application records do not expose ContentType in byte 0.
    const application = Buffer.from([1, 4, 5, 6]);

    try {
      // Act: 共通 flush と直接の sendAndWait を control として pending queue へ登録する。
      const controlSend = flushTransportSend(
        transport,
        control,
        pair.remoteAddr,
      );
      const directControlSend = transport.sendAndWait(
        directControl,
        pair.remoteAddr,
      );
      const applicationSend = transport.sendApplication(
        application,
        pair.remoteAddr,
      );
      await Promise.resolve();

      // Act: 設定変更で early application だけを取り消す。
      transport.setEarlyApplicationSendEnabled(false);
      await expect(applicationSend).rejects.toThrow(/permission revoked/);
      expect(
        (transport as unknown as { pendingEarlySends: unknown[] })
          .pendingEarlySends,
      ).toHaveLength(2);

      // Act: pair 認証を成立させ、残った control record を flush する。
      pair.requestsReceived = 1;
      pair.updateState(CandidatePairState.SUCCEEDED);
      connectionDatagramEvent(ice).execute({
        bytes: Buffer.from([0, 1]),
        source: pair.remoteAddr,
        protocol: a.protocol,
        pair,
        generation: ice.generation,
        authenticated: true,
      });
      await Promise.all([controlSend, directControlSend]);

      // Assert: 2種類の control だけが wire に出て、取り消した application は出ない。
      expect(a.sent).toHaveLength(2);
      expect(a.sent[0]!.data.equals(control)).toBe(true);
      expect(a.sent[1]!.data.equals(directControl)).toBe(true);

      // Act: policy 無効後に認証済み pair へ直接 early application を送る。
      await expect(
        transport.sendApplication(application, pair.remoteAddr),
      ).rejects.toThrow(/permission revoked/);

      // Assert: 直接送信経路も取り消し済み policy を迂回しない。
      expect(a.sent).toHaveLength(2);
    } finally {
      await transport.close();
    }
  });

  it("application data の期限切れ後は経路復旧しても古いデータを送らない", async () => {
    // Arrange: application-ready だが、ICE の送信経路だけを一時的に失わせる。
    vi.useFakeTimers();
    const ice = createIceStub(1);
    const transport = new IceSpedTransport(ice);
    transport.markApplicationReady();
    const staleApplication = Buffer.from([23, 8, 7, 6]);

    try {
      // Act: 通常の application send を受理し、期限付き queue に入れる。
      await transport.send(staleApplication);
      await Promise.resolve();
      const pending = (
        transport as unknown as {
          pendingEarlySends: { expiresAt?: number }[];
        }
      ).pendingEarlySends;
      expect(pending).toHaveLength(1);
      expect(pending[0]!.expiresAt).toEqual(expect.any(Number));

      // Act: 経路が復旧しないまま retention を経過させる。
      await vi.advanceTimersByTimeAsync(2_000);

      // Assert: 期限切れで queue/timer を破棄する。
      expect(
        (
          transport as unknown as {
            pendingEarlySends: unknown[];
          }
        ).pendingEarlySends,
      ).toHaveLength(0);
      expect(
        (
          transport as unknown as {
            earlySendExpiryTimer?: unknown;
            earlySendRetryTimer?: unknown;
          }
        ).earlySendExpiryTimer,
      ).toBeUndefined();

      // Act: その後に nomination/consent を成立させ、保留データを flush する。
      const pair = authenticatedPair(
        mockProtocol("1.2.3.4", 1000).protocol,
        "10.0.0.1",
        1111,
      );
      ice.nominated = pair;
      ice.applicationDataReady = true;
      ice.stateChanged.execute("connected");
      await vi.advanceTimersByTimeAsync(0);

      // Assert: 復旧後も期限切れした古い application data は wire に出ない。
      expect(ice.sent).toHaveLength(0);
    } finally {
      await transport.close();
      vi.useRealTimers();
    }
  });
});
