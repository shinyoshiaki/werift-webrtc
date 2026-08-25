import { CandidatePair, CandidatePairState } from "../../src";
import { Candidate } from "../../src/candidate";
import {
  type IceDatagramContext,
  allowsAuthenticatedDtlsDelivery,
  isAuthenticatedHandshakePair,
} from "../../src/internal/datagram";
import { SpedProtocolMock } from "./helpers";

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
