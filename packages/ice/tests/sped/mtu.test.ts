import { encodeSpedAck } from "../../src/sped/draft00";
import { SPED_OUTER_MTU } from "../../src/sped/draft00/constants";
import {
  defaultSpedDtlsMtu,
  maxPayloadFitting,
  remainingDataValueBudget,
} from "../../src/sped/draft00/mtu";
import { SpedSession } from "../../src/sped/draft00/session";
import { SpedRuntime } from "../../src/sped/runtime";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { SpedProtocolMock } from "./helpers";

describe("SPED MTU", () => {
  it("defaultSpedDtlsMtu は 1200 から STUN overhead を引く", () => {
    // Arrange / Act
    const mtu = defaultSpedDtlsMtu();

    // Assert: HMAC-SHA1 Binding を載せる分だけ 1200 より小さい
    expect(mtu).toBeLessThan(SPED_OUTER_MTU);
    expect(mtu).toBeGreaterThan(800);
  });

  it("decorateOutgoing は実 Binding skeleton から carrier MTU を更新する", () => {
    // Arrange
    const mtus: number[] = [];
    const session = new SpedSession(0);
    session.queueAck(1);
    session.queueAck(2);
    const runtime = new SpedRuntime(session, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: (mtu) => {
        mtus.push(mtu);
      },
    });
    const protocol = new SpedProtocolMock();
    const message = new Message(methods.BINDING, classes.REQUEST);
    message.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    const ackValue = encodeSpedAck(session.peekAcksForBinding()).value;
    const expected = Math.max(
      1,
      maxPayloadFitting(remainingDataValueBudget(message, ackValue)),
    );

    // Act: 実 Binding に ACK/DATA を載せる直前の skeleton で MTU を決める
    runtime.decorateOutgoing(message, protocol);

    // Assert: 既定 USE-CANDIDATE skeleton ではなく、この Binding の残予算
    expect(mtus.at(-1)).toBe(expected);
    expect(mtus.at(-1)).not.toBe(defaultSpedDtlsMtu());
    expect(mtus.at(-1)!).toBeGreaterThan(defaultSpedDtlsMtu());
  });
});
