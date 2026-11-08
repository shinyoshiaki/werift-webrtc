import { CandidatePairState } from "../../src/iceBase";
import {
  answerOnlyRelayOf,
  createHangingTlsServer,
  createLateRelaySetup,
  deliverLocalCandidates,
  forwardLocalCandidates,
  localRelayCandidates,
  queuedCheckListResults,
  relayPairs,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
  waitUntil,
} from "../utils";

describe("TURN relay candidate gathered after the remote candidates", () => {
  test("pairs with the remote candidates already known", async () => {
    // Arrange: late の TURN allocation を保留したまま、early の候補を先に届ける
    const { late, early, proxy, gathering, close } =
      await createLateRelaySetup();
    try {
      await deliverLocalCandidates(early, late, { endOfCandidates: true });
      expect(relayPairs(late)).toHaveLength(0);

      // Act: TURN allocation を完了させて収集を終える
      proxy.release();
      await gathering;

      // Assert: relay 候補が既存のリモート候補それぞれと 1 つずつペアになる
      const [relay] = localRelayCandidates(late);
      expect(relay).toBeDefined();
      const pairs = relayPairs(late);
      expect(pairs.map((pair) => pair.remoteCandidate.foundation)).toEqual(
        early.localCandidates.map((candidate) => candidate.foundation),
      );
      // Assert: ペアは connectivity check 待ち (WAITING) になる
      for (const pair of pairs) {
        expect(pair.state).toBe(CandidatePairState.WAITING);
      }
    } finally {
      await close();
    }
  }, 30000);

  test("a relay pair added while connect() runs is checked and connects after the peer's end-of-candidates", async () => {
    // Arrange: late は relay-only。TURN allocation を保留し、early の候補と end-of-candidates を先に届ける
    const { late, early, proxy, gathering, close } = await createLateRelaySetup(
      { late: { forceTurn: true } },
    );
    try {
      await deliverLocalCandidates(early, late, { endOfCandidates: true });
      forwardLocalCandidates(late, early);
      const connecting = Promise.all([late.connect(), early.connect()]);
      let settled = false;
      void connecting.finally(() => {
        settled = true;
      });

      // Act: 空の check list で connect() が回っている間に TURN allocation を完了させる
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Assert: ローカル収集中は connect() が失敗も終了もしない
      expect(settled).toBe(false);
      proxy.release();
      await gathering;
      await early.addRemoteCandidate(undefined);
      await connecting;

      // Assert: 後から作られた relay ペアが check を受けて成功し、nominate される
      const [pair] = relayPairs(late);
      expect(pair.state).toBe(CandidatePairState.SUCCEEDED);
      expect(late.nominated).toBe(pair);
      expect(early.nominated?.localCandidate.type).toBe("relay");
    } finally {
      await close();
    }
  }, 30000);

  test("host pairs that all fail leave the check list running until the late relay pair succeeds", async () => {
    // Arrange: early は late の relay 候補からの check にしか応答しない (host 経路が通らない NAT 相当)
    const { late, early, proxy, gathering, close } = await createLateRelaySetup(
      {
        early: (server, late) => ({
          stunServer: undefined,
          turnServer: server.address!,
          turnUsername: TURN_TEST_USERNAME,
          turnPassword: TURN_TEST_PASSWORD,
          forceTurn: true,
          filterStunResponse: answerOnlyRelayOf(late),
        }),
      },
    );
    try {
      await deliverLocalCandidates(early, late, { endOfCandidates: true });
      forwardLocalCandidates(late, early);
      const connecting = Promise.all([late.connect(), early.connect()]);
      let settled = false;
      void connecting.finally(() => {
        settled = true;
      });

      // Act: host ペアがすべて失敗するまで待つ
      await waitUntil(
        () =>
          late.checkList.length > 0 &&
          late.checkList.every(
            (pair) => pair.state === CandidatePairState.FAILED,
          ),
      );
      // Assert: 収集中なので check list は Failed にならず、connect() も終わらない
      expect(queuedCheckListResults(late)).toBe(0);
      expect(settled).toBe(false);

      // Act: TURN allocation を完了させる
      proxy.release();
      await gathering;
      await early.addRemoteCandidate(undefined);
      await connecting;

      // Assert: relay ペアで接続が成立する
      expect(late.nominated?.localCandidate.type).toBe("relay");
      expect(late.nominated?.state).toBe(CandidatePairState.SUCCEEDED);
    } finally {
      await close();
    }
  }, 30000);

  test("a relay candidate gathered before the remote candidates pairs once and connects", async () => {
    // Arrange: late の収集を TURN まで終えてから候補を交換する
    const { late, early, proxy, gathering, close } = await createLateRelaySetup(
      { late: { forceTurn: true } },
    );
    try {
      proxy.release();
      await gathering;
      await deliverLocalCandidates(early, late, { endOfCandidates: true });
      await deliverLocalCandidates(late, early, { endOfCandidates: true });

      // Act: 両側で接続する
      await Promise.all([late.connect(), early.connect()]);

      // Assert: relay ペアはリモート候補ごとに 1 つだけ (重複しない)
      const keys = relayPairs(late).map(
        (pair) =>
          `${pair.protocol.localCandidate?.foundation}/${pair.remoteCandidate.foundation}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toHaveLength(early.localCandidates.length);
      // Assert: relay ペアで接続する
      expect(late.nominated?.localCandidate.type).toBe("relay");
    } finally {
      await close();
    }
  }, 30000);

  test("connect() keeps scheduling until gathering ends, then fails instead of hanging", async () => {
    // Arrange: TLS handshake が終わらない TURN server。relay-only なので check list は空のまま
    const tlsServer = await createHangingTlsServer();
    const { late, early, gathering, close } = await createLateRelaySetup({
      late: {
        forceTurn: true,
        turnServer: tlsServer.address,
        turnTransport: "tls",
        turnConnectTimeout: 0.5,
      },
    });
    const order: string[] = [];
    void gathering.then(() => order.push("gathered"));
    try {
      await deliverLocalCandidates(early, late, { endOfCandidates: true });

      // Act: end-of-candidates 受信済み・ローカル収集中に connect() する
      const result = await late.connect().then(
        () => "connected",
        (error: Error) => error.message,
      );
      order.push("connect settled");

      // Assert: 収集 (TURN 失敗) が終わってから、connect() はハングせず失敗で終わる
      expect(result).toBe("ICE negotiation failed");
      expect(order).toEqual(["gathered", "connect settled"]);
    } finally {
      await close();
      await tlsServer.close();
    }
  }, 30000);

  test("a relay candidate gathered after nomination starts no check", async () => {
    // Arrange: early は host-only。late の TURN allocation を保留したまま host ペアで接続する
    const { late, early, proxy, gathering, close } = await createLateRelaySetup(
      { early: () => ({}) },
    );
    try {
      await deliverLocalCandidates(early, late, { endOfCandidates: true });
      forwardLocalCandidates(late, early);
      await Promise.all([late.connect(), early.connect()]);
      const nominated = late.nominated;
      expect(nominated?.localCandidate.type).toBe("host");

      // Act: nominate 後に TURN allocation を完了させる
      proxy.release();
      await gathering;
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Assert: relay 候補は通知されるが、ペアは作られず nominate も変わらない
      expect(localRelayCandidates(late)).toHaveLength(1);
      expect(relayPairs(late)).toHaveLength(0);
      expect(late.nominated).toBe(nominated);
    } finally {
      await close();
    }
  }, 30000);
});
