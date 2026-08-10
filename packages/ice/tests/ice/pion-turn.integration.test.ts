import type { Address } from "../../../common/src";
import { createTurnClient } from "../../src/turn/protocol";
import { createTestConnection } from "../utils";

/**
 * Opt-in interop against a third-party pion TURN server.
 *
 * Gate: set PION_TURN_HOST (and usually PION_TURN_PORT / credentials).
 * Recommended (trap always downs compose):
 *   npm run test:pion-turn --workspace packages/ice
 * Manual:
 *   eval "$(./packages/ice/scripts/run-pion-turn.sh --print-env)"
 *   npm test --workspace packages/ice -- pion-turn
 *   ./packages/ice/scripts/run-pion-turn.sh --down
 *
 * Without PION_TURN_HOST this suite is skipped so default CI stays green.
 */
const pionHost = process.env.PION_TURN_HOST;
const pionPort = Number(process.env.PION_TURN_PORT ?? "3478");
const pionUsername = process.env.PION_TURN_USERNAME ?? "username";
const pionPassword = process.env.PION_TURN_PASSWORD ?? "password";
const describePion = pionHost ? describe : describe.skip;

describePion("pion TURN interop (opt-in via PION_TURN_HOST)", () => {
  const turnServer: Address = [pionHost!, pionPort];

  test("ICE forceTurn relay connects through pion and exchanges data both ways", async () => {
    // Arrange: 両端とも pion TURN の relay のみ
    const connectionOptions = {
      stunServer: undefined,
      turnServer,
      turnUsername: pionUsername,
      turnPassword: pionPassword,
      turnTransport: "udp" as const,
      forceTurn: true,
    };
    const a = createTestConnection(true, connectionOptions);
    const b = createTestConnection(false, connectionOptions);

    try {
      // Act: 候補収集 → relay のみ交換 → 接続
      await a.gatherCandidates();
      await b.gatherCandidates();

      b.remoteCandidates = a.localCandidates.filter(
        (candidate) => candidate.type === "relay",
      );
      b.remoteUsername = a.localUsername;
      b.remotePassword = a.localPassword;
      a.remoteCandidates = b.localCandidates.filter(
        (candidate) => candidate.type === "relay",
      );
      a.remoteUsername = b.localUsername;
      a.remotePassword = b.localPassword;

      // Assert: relay 候補が得られている
      expect(a.localCandidates.length).toBeGreaterThan(0);
      expect(b.localCandidates.length).toBeGreaterThan(0);
      expect(
        a.localCandidates.every((candidate) => candidate.type === "relay"),
      ).toBe(true);
      expect(
        b.localCandidates.every((candidate) => candidate.type === "relay"),
      ).toBe(true);

      // Act: ICE 接続
      await Promise.all([a.connect(), b.connect()]);

      // Assert: nominated が relay 同士
      expect(a.nominated?.localCandidate.type).toBe("relay");
      expect(a.nominated?.remoteCandidate.type).toBe("relay");
      expect(b.nominated?.localCandidate.type).toBe("relay");
      expect(b.nominated?.remoteCandidate.type).toBe("relay");

      // Act / Assert: 双方向データ
      await a.send(Buffer.from("howdee-over-pion"));
      let [data] = await b.onData.asPromise();
      expect(data.toString()).toBe("howdee-over-pion");

      await b.send(Buffer.from("gotcha-over-pion"));
      [data] = await a.onData.asPromise();
      expect(data.toString()).toBe("gotcha-over-pion");
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  test("createTurnClient pair can ChannelBind and exchange ChannelData via pion", async () => {
    // Arrange: TURN client を 2 つ allocation
    const receiver = await createTurnClient(
      {
        address: turnServer,
        username: pionUsername,
        password: pionPassword,
      },
      { transport: "udp" },
    );
    const sender = await createTurnClient(
      {
        address: turnServer,
        username: pionUsername,
        password: pionPassword,
      },
      { transport: "udp" },
    );

    try {
      // Act: 相互 ChannelBind
      await sender.getChannel(receiver.relayedAddress);
      await receiver.getChannel(sender.relayedAddress);

      const received = new Promise<string>((resolve) => {
        receiver.onData.subscribe((data) => {
          resolve(data.toString());
        });
      });

      // Act: ChannelData 送信
      await sender.sendData(
        Buffer.from("pion-channel-data"),
        receiver.relayedAddress,
      );

      // Assert
      await expect(received).resolves.toBe("pion-channel-data");
    } finally {
      await sender.close();
      await receiver.close();
    }
  }, 60_000);
});
