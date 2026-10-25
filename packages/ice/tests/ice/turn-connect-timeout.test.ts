import { Connection } from "../../src/ice";
import {
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  createHangingTlsServer,
} from "../utils";

describe("TURN stream connection timeout", () => {
  test("finishes gathering and preserves host candidates when TURN TLS hangs", async () => {
    // Arrange: TLS handshake を完了しない TURN endpoint と host 候補を設定する。
    const server = await createHangingTlsServer();
    const connection = new Connection(true, {
      turnServer: server.address,
      turnUsername: TURN_TEST_USERNAME,
      turnPassword: TURN_TEST_PASSWORD,
      turnTransport: "tls",
      turnTlsOptions: { rejectUnauthorized: false },
      turnConnectTimeout: 0.2,
      stunGatherTimeout: 0.05,
      useIpv4: false,
      useIpv6: false,
      additionalHostAddresses: ["127.0.0.1"],
    });
    const startedAt = Date.now();

    try {
      // Act: 応答しない TURN TLS を含む候補収集を完了まで待つ。
      await connection.gatherCandidates();

      // Assert: タイムアウト後に gathering が完了し、host 候補だけが残る。
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(connection.state).toBe("completed");
      expect(
        connection.localCandidates.some(({ type }) => type === "host"),
      ).toBe(true);
      expect(
        connection.localCandidates.some(({ type }) => type === "relay"),
      ).toBe(false);
      await vi.waitFor(() => expect(server.sockets.size).toBe(0));
    } finally {
      await connection.close();
      await server.close();
    }
  });

  test("finishes relay-only gathering when TURN TLS hangs", async () => {
    // Arrange: relay-only connection に TLS handshake を完了しない TURN endpoint を設定する。
    const server = await createHangingTlsServer();
    const connection = new Connection(true, {
      turnServer: server.address,
      turnUsername: TURN_TEST_USERNAME,
      turnPassword: TURN_TEST_PASSWORD,
      turnTransport: "tls",
      turnTlsOptions: { rejectUnauthorized: false },
      turnConnectTimeout: 0.2,
      forceTurn: true,
      useIpv4: true,
      useIpv6: false,
    });

    try {
      // Act: relay-only の候補収集を完了まで待つ。
      await connection.gatherCandidates();

      // Assert: TURN failure が全体を止めず、候補なしで gathering が完了する。
      expect(connection.state).toBe("completed");
      expect(connection.localCandidates).toEqual([]);
    } finally {
      await connection.close();
      await server.close();
    }
  });
});
