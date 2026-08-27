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
  const ice = {
    generation,
    nominated: undefined as CandidatePair | undefined,
    checkList,
    send: async () => {},
  };
  return ice as unknown as Connection;
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

function authenticatedPair(
  protocol: any,
  host: string,
  port: number,
): CandidatePair {
  const pair = new CandidatePair(
    protocol,
    new Candidate("r", 1, "udp", 1, host, port, "host"),
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
});
