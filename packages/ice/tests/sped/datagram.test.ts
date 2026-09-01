import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import {
  type IceDatagramContext,
  allowsAuthenticatedDtlsDelivery,
  connectionDatagramEvent,
  isAuthenticatedHandshakePair,
} from "../../src/internal/datagram";
import { createTestConnection } from "../utils";
import { SpedProtocolMock, spedPair } from "./helpers";

function context(
  overrides: Partial<IceDatagramContext> & Pick<IceDatagramContext, "protocol">,
): IceDatagramContext {
  return {
    bytes: Buffer.from([22, 1]),
    source: ["9.9.9.9", 9],
    pair: undefined,
    generation: 1,
    authenticated: true,
    ...overrides,
  };
}

describe("allowsAuthenticatedDtlsDelivery", () => {
  it("認証済み・現行 generation・pair の protocol/source が一致するときだけ通す", () => {
    // Arrange
    const protocol = new SpedProtocolMock();
    const pair = new CandidatePair(
      protocol,
      new Candidate("f", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    const ctx = context({
      protocol,
      pair,
      authenticated: true,
      generation: 3,
      source: ["9.9.9.9", 9],
    });

    // Act / Assert
    expect(allowsAuthenticatedDtlsDelivery(ctx, 3)).toBe(true);
  });

  it("未認証・旧 generation・pair 無し・protocol 不一致・source 不一致は拒否する", () => {
    // Arrange
    const protocol = new SpedProtocolMock();
    const other = new SpedProtocolMock();
    const pair = new CandidatePair(
      protocol,
      new Candidate("f", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );

    // Act / Assert: いずれか欠けると DTLS に渡さない
    expect(
      allowsAuthenticatedDtlsDelivery(
        context({ protocol, pair, authenticated: false, generation: 1 }),
        1,
      ),
    ).toBe(false);
    expect(
      allowsAuthenticatedDtlsDelivery(
        context({ protocol, pair, authenticated: true, generation: 1 }),
        2,
      ),
    ).toBe(false);
    expect(
      allowsAuthenticatedDtlsDelivery(
        context({ protocol, authenticated: true, generation: 1 }),
        1,
      ),
    ).toBe(false);
    expect(
      allowsAuthenticatedDtlsDelivery(
        context({
          protocol: other,
          pair,
          authenticated: true,
          generation: 1,
        }),
        1,
      ),
    ).toBe(false);
    expect(
      allowsAuthenticatedDtlsDelivery(
        context({
          protocol,
          pair,
          authenticated: true,
          generation: 1,
          source: ["8.8.8.8", 9],
        }),
        1,
      ),
    ).toBe(false);
  });
});

describe("isAuthenticatedHandshakePair", () => {
  it("WAITING でも認証済み Binding Request 受信後は true", () => {
    // Arrange
    const protocol = new SpedProtocolMock();
    const pair = new CandidatePair(
      protocol,
      new Candidate("f", 1, "udp", 1, "9.9.9.9", 9, "host"),
      true,
    );
    pair.updateState(CandidatePairState.WAITING);

    // Act / Assert: 送信経路と同じ。responsesReceived が 0 でも request 受信で通す
    expect(isAuthenticatedHandshakePair(pair)).toBe(false);
    pair.requestsReceived = 1;
    expect(isAuthenticatedHandshakePair(pair)).toBe(true);
  });
});

describe("Connection datagram routing without source", () => {
  it("source 無しの onDataReceived は認証済み nominated pair でも DTLS に渡さない", () => {
    // Arrange: custom Protocol が source を省略してもよい public 型
    const connection = createTestConnection(true);
    const protocol = new SpedProtocolMock();
    (connection as any).ensureProtocol(protocol);
    const pair = spedPair(protocol, "host", "9.9.9.9", 9);
    pair.requestsReceived = 1;
    pair.nominated = true;
    connection.checkList.push(pair);
    connection.nominated = pair;
    const dtls = Buffer.from([22, 1, 2, 3]);
    const seen: IceDatagramContext[] = [];
    const appData: Buffer[] = [];
    connectionDatagramEvent(connection).subscribe((ctx) => {
      seen.push(ctx);
    });
    connection.onData.subscribe((data) => {
      appData.push(data);
    });

    // Act: 従来どおり source 無しで発火する
    protocol.onDataReceived.execute(dtls);

    // Assert: pair.remoteAddr を捏造せず、handshake DTLS は拒否。onData は互換のため発火する
    expect(appData).toHaveLength(1);
    expect(appData[0]!.equals(dtls)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authenticated).toBe(false);
    expect(seen[0]!.source).toEqual(["0.0.0.0", 0]);
    expect(seen[0]!.source).not.toEqual(pair.remoteAddr);
    expect(
      allowsAuthenticatedDtlsDelivery(seen[0]!, connection.generation),
    ).toBe(false);

    // Act: 同じ bytes を正しい remote 5-tuple 付きで再送する
    protocol.onDataReceived.execute(dtls, pair.remoteAddr);

    // Assert: source があるときだけ DTLS へ通す
    expect(seen).toHaveLength(2);
    expect(seen[1]!.authenticated).toBe(true);
    expect(seen[1]!.source).toEqual(pair.remoteAddr);
    expect(
      allowsAuthenticatedDtlsDelivery(seen[1]!, connection.generation),
    ).toBe(true);
    expect(appData).toHaveLength(2);
  });
});
