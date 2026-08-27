import { encodeSpedAck } from "../../src/sped/draft00";
import { SPED_OUTER_MTU } from "../../src/sped/draft00/constants";
import {
  defaultSpedDtlsMtu,
  maxPayloadFitting,
  remainingDataValueBudget,
  spedBindingRequestSkeleton,
  spedBindingResponseSkeleton,
  spedDtlsMtuForIceCredentials,
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

  it("path MTU は Request と Response の小さい方", () => {
    // Arrange
    const credentials = {
      localUsername: "abcd",
      remoteUsername: "efghijkl",
      useIpv6: false,
    };
    const ackValue = Buffer.alloc(16);
    const requestMtu = maxPayloadFitting(
      remainingDataValueBudget(
        spedBindingRequestSkeleton(credentials),
        ackValue,
      ),
    );
    const responseMtu = maxPayloadFitting(
      remainingDataValueBudget(
        spedBindingResponseSkeleton(credentials),
        ackValue,
      ),
    );

    // Act
    const mtu = spedDtlsMtuForIceCredentials(credentials);

    // Assert
    expect(mtu).toBe(Math.max(1, Math.min(requestMtu, responseMtu)));
  });

  it("長い ICE USERNAME は default skeleton より MTU を小さくする", () => {
    // Arrange / Act
    const long = spedDtlsMtuForIceCredentials({
      localUsername: "L".repeat(16),
      remoteUsername: "R".repeat(16),
      useIpv6: true,
    });

    // Assert
    expect(long).toBeLessThan(defaultSpedDtlsMtu());
  });

  it("attach 時に実 credential の path MTU を carrier へ渡す", () => {
    // Arrange
    const mtus: number[] = [];
    const session = new SpedSession(0);
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
    const expected = spedDtlsMtuForIceCredentials({
      localUsername: "L".repeat(16),
      remoteUsername: "R".repeat(16),
      useIpv6: false,
    });

    // Act: DTLS first flight 前に実 ufrag で min(Request, Response)
    runtime.syncPathMtuFromConnection({
      localUsername: "L".repeat(16),
      remoteUsername: "R".repeat(16),
      options: { useIpv6: false },
    });

    // Assert
    expect(mtus.at(-1)).toBe(expected);
    expect(mtus.at(-1)!).toBeLessThan(defaultSpedDtlsMtu());
  });

  it("custom raw で Binding budget が縮むと MTU を下げ refragment する", () => {
    // Arrange
    const mtus: number[] = [];
    let refrag = 0;
    const session = new SpedSession(0);
    session.replaceL1([Buffer.alloc(900)]);
    const runtime = new SpedRuntime(session, {
      inject: async () => {},
      onFallbackFlight: async () => {},
      setRetransmissionMode: () => {},
      updateRtt: () => {},
      resetRtt: () => {},
      setMtu: (mtu) => {
        mtus.push(mtu);
      },
      refragmentPendingFlight: () => {
        refrag++;
        session.replaceL1([Buffer.alloc(40)]);
      },
    });
    runtime.syncPathMtuFromConnection({
      localUsername: "a",
      remoteUsername: "b",
      options: { useIpv6: false },
    });
    const pathMtu = mtus.at(-1)!;
    const protocol = new SpedProtocolMock();
    const message = new Message(methods.BINDING, classes.REQUEST);
    message.setAttribute("USERNAME", "a:b").setAttribute("PRIORITY", 1);
    message.appendRawAttribute(0xc001, Buffer.alloc(200));
    const ackValue = encodeSpedAck(session.peekAcksForBinding()).value;
    const bindingMtu = Math.max(
      1,
      maxPayloadFitting(remainingDataValueBudget(message, ackValue)),
    );

    // Act
    const ok = runtime.decorateOutgoing(message, protocol);

    // Assert: この Binding の残予算まで下げ、oversized L1 を差し替える
    expect(bindingMtu).toBeLessThan(pathMtu);
    expect(mtus.at(-1)).toBe(bindingMtu);
    expect(refrag).toBe(1);
    expect(ok).toBe(true);
    expect(session.l1Datagrams[0]!.length).toBe(40);
  });
});
