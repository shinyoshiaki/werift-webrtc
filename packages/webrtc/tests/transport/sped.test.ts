import { Event } from "../../../common/src";
import type { Connection } from "../../../ice/src";
import { CandidatePair } from "../../../ice/src";
import { Candidate } from "../../../ice/src/candidate";
import type { IceDatagramContext } from "../../../ice/src/internal/datagram";
import { IceSpedTransport } from "../../src/transport/sped";

function createIceStub(generation = 1) {
  const ice = {
    generation,
    onDatagram: new Event<[IceDatagramContext]>(),
    nominated: undefined,
    send: async () => {},
  };
  return ice as unknown as Connection & {
    generation: number;
    onDatagram: Event<[IceDatagramContext]>;
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
    ice.onDatagram.execute(allowed);
    ice.onDatagram.execute({
      ...allowed,
      source: ["8.8.8.8", 9],
    });
    ice.onDatagram.execute({
      ...allowed,
      authenticated: false,
    });
    ice.onDatagram.execute({
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
    ice.onDatagram.execute({
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
