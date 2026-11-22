import { CandidatePair } from "../../src";
import { attachSpedToConnection } from "../../src/internal/sped";
import { DTLS_IN_STUN_DATA } from "../../src/sped/draft00/constants";
import { classes } from "../../src/stun/const";
import type { Message } from "../../src/stun/message";
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import type { Protocol } from "../../src/types/model";
import { createTestConnection, inviteAccept } from "../utils";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("early Binding の SPED Response", () => {
  it("B の connect() 前に A の SPED Binding が着いても Response に C070 があり A は fallback しない", async () => {
    // Arrange: 候補交換まで済ませ、B は connect() しない（earlyChecks）
    const a = createTestConnection(true, { useIpv6: false });
    const b = createTestConnection(false, { useIpv6: false });
    const hello = Buffer.from([22, 0xfe, 0xfd, 0x00, 0x01, 0x02]);
    const handleA = attachSpedToConnection(a, dummySpedHooks());
    const handleB = attachSpedToConnection(b, dummySpedHooks());
    handleA.session.replaceL1([hello]);
    handleB.session.replaceL1([hello]);
    await inviteAccept(a, b);

    const bResponses: Message[] = [];
    for (const protocol of (b as unknown as { protocols: Protocol[] })
      .protocols) {
      const sendStun = protocol.sendStun.bind(protocol);
      protocol.sendStun = async (message, addr) => {
        if (message.messageClass === classes.RESPONSE) {
          bResponses.push(message);
        }
        return sendStun(message, addr);
      };
    }

    try {
      // Act: A だけ connect し、B の early Binding Response を待つ
      const aConnect = a.connect();
      await waitUntil(
        () =>
          bResponses.some(
            (message) =>
              getRawAttributeValue(message, DTLS_IN_STUN_DATA) !== undefined,
          ) && handleA.session.peerSupport !== "unknown",
      );

      // Assert: B はまだ connect() していないが C070 を返し、A は fallback しない
      expect(
        (b as unknown as { earlyChecksDone: boolean }).earlyChecksDone,
      ).toBe(false);
      expect(handleA.session.peerSupport).toBe("supported");
      expect(handleA.session.state).not.toBe("fallback");

      // Act: B が connect して ICE を完了し、SPED handshake を閉じる
      await Promise.all([aConnect, b.connect()]);
      handleA.runtime.completeHandshake();
      handleB.runtime.completeHandshake();

      // Assert
      expect(handleA.session.state).toBe("complete");
      expect(handleB.session.state).toBe("complete");
      expect(a.nominated).toBeInstanceOf(CandidatePair);
      expect(b.nominated).toBeInstanceOf(CandidatePair);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
