import { SpedSession } from "../../src/sped/draft00/session";
import { SpedRuntime } from "../../src/sped/runtime";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { SpedProtocolMock, spedPair } from "./helpers";

/** Shared Arrange: a probing session and its runtime with no-op hooks. */
function probingRuntime() {
  const session = new SpedSession(0);
  const runtime = new SpedRuntime(session, {
    inject: async () => {},
    onFallbackFlight: async () => {},
    setRetransmissionMode: () => {},
    updateRtt: () => {},
    resetRtt: () => {},
    setMtu: () => {},
  });
  return { session, runtime };
}

function bindingRequest() {
  const request = new Message(methods.BINDING, classes.REQUEST);
  request.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
  return request;
}

describe("SPED: selected pair that cannot carry SPED", () => {
  test("support が未決定のまま relay pair が選ばれると fallback になり、probe path を外す", () => {
    const { session, runtime } = probingRuntime();
    const host = spedPair(new SpedProtocolMock(), "host");
    runtime.pinHandshakePath(host);

    // Act: relay pair が選択される
    const started = runtime.settleIneligibleSelectedPair(
      spedPair(new SpedProtocolMock(), "relay"),
    );

    // Assert: fallback に移り、support は未決定のまま、旧 probe path は使わない
    expect(started).toBe(true);
    expect(session.state).toBe("fallback");
    expect(session.peerSupport).toBe("unknown");
    expect(runtime.lastPath).toBeUndefined();
  });

  test("SPED を載せられる pair の選択、または support 決定後は fallback にしない", () => {
    const eligible = probingRuntime();
    const decided = probingRuntime();
    decided.session.noteAuthenticatedBindingHasData(true);

    // Act: host pair の選択と、support 決定後の relay pair の選択
    const onHost = eligible.runtime.settleIneligibleSelectedPair(
      spedPair(new SpedProtocolMock(), "host"),
    );
    const afterSupport = decided.runtime.settleIneligibleSelectedPair(
      spedPair(new SpedProtocolMock(), "relay"),
    );

    // Assert: どちらも状態を変えない
    expect(onHost).toBe(false);
    expect(eligible.session.state).toBe("probing");
    expect(afterSupport).toBe(false);
    expect(decided.session.state).toBe("active");
  });

  test("handshakeDataSent は空でない DATA を載せたときだけ立ち、reset で戻る", () => {
    const { session } = probingRuntime();

    // Act: L1 が空の decorate（capability 広告と同じ空 DATA）
    session.decorate(bindingRequest());
    const afterEmpty = session.handshakeDataSent;
    // Act: handshake packet を L1 に置いて decorate する
    session.replaceL1([Buffer.from([22, 254, 253, 0, 0])]);
    session.decorate(bindingRequest());
    const afterData = session.handshakeDataSent;
    session.reset(1);

    // Assert: 空 DATA では立たず、packet を載せると立ち、新 generation で戻る
    expect(afterEmpty).toBe(false);
    expect(afterData).toBe(true);
    expect(session.handshakeDataSent).toBe(false);
  });
});
