import { getHostAddresses } from "../../../ice/src/utils";
import {
  createLocalTurnServer,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../../../ice/tests/utils";
import { RTCIceGatherer, RTCIceTransport, RTCPeerConnection } from "../../src";
import { iceTransportPair } from "../fixture";
import {
  connectPeerConnections,
  createPeerConnectionWithIceTransport,
  createTurnRotationServers,
  firstIceTransport,
  negotiate,
  peerTurnAllocations,
  waitForLocalCandidatesEnd,
} from "../utils";

describe("iceTransport", () => {
  test("ICE consent failure maps to failed without closing PeerConnection", async () => {
    // Arrange: 外部ネットワーク不要。datachannel 作成で ICE transport を用意する
    const pc = new RTCPeerConnection({ iceServers: [] });
    try {
      pc.createDataChannel("consent");
      const ice = (pc as any).secureManager.iceTransports[0] as RTCIceTransport;
      expect(ice).toBeDefined();

      // Act: connected の後に consent 失効相当の failed を通知
      (ice.connection as any).setState("connected");
      expect(ice.state).toBe("connected");
      (ice.connection as any).setState("failed");

      // Assert: transport / iceConnectionState / connectionState は failed。
      // PeerConnection 自体は closed にならない（明示 close と区別）。
      expect(ice.state).toBe("failed");
      expect(pc.iceConnectionState).toBe("failed");
      expect(pc.connectionState).toBe("failed");
      expect(pc.signalingState).not.toBe("closed");
    } finally {
      await pc.close();
    }
  });

  describe("setConfiguration iceServers", () => {
    test("gathering 前の setConfiguration が Connection に TURN を反映する", async () => {
      // Arrange: createOffer で gatherer を作るが、まだ gather していない (WHIP パス)
      const pc = new RTCPeerConnection({ iceServers: [] });
      try {
        pc.createDataChannel("whip");
        await pc.createOffer();
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        expect(ice.gatheringState).toBe("new");
        expect(ice.connection.turnServer).toBeUndefined();

        // Act: WHIP Link ヘッダ相当の TURN を setConfiguration
        pc.setConfiguration({
          iceServers: [
            {
              urls: "turn:turn.example.com:3478",
              username: "whip-user",
              credential: "whip-pass",
            },
          ],
        });

        // Assert: 次の gather で使えるよう Connection に stage される
        expect(ice.connection.turnServer).toEqual(["turn.example.com", 3478]);
        expect(ice.connection.options.turnUsername).toBe("whip-user");
        expect(ice.connection.options.turnPassword).toBe("whip-pass");
        expect((pc as any).needRestart).toBe(false);
      } finally {
        await pc.close();
      }
    });

    test("WHIP: setConfiguration 後の setLocalDescription/gather で TURN relay が生成される", async () => {
      // Arrange: ローカル TURN + WHIP 相当（offer 時点では iceServers 空）
      const localTurnHost = getHostAddresses(true, false)[0]!;
      const turnServer = await createLocalTurnServer(localTurnHost);
      const [turnHost, turnPort] = turnServer.address!;

      const pc = new RTCPeerConnection({
        iceServers: [],
        iceTransportPolicy: "relay",
      });
      try {
        pc.createDataChannel("whip-relay");
        // Act: 先に offer を作り gatherer を構築（まだ gather しない）
        const offer = await pc.createOffer();
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        expect(ice.gatheringState).toBe("new");
        expect(ice.connection.turnServer).toBeUndefined();
        expect(ice.localCandidates).toEqual([]);

        // Act: WHIP Link ヘッダ相当で TURN を setConfiguration してから gather
        pc.setConfiguration({
          iceServers: [
            {
              urls: `turn:${turnHost}:${turnPort}`,
              username: TURN_TEST_USERNAME,
              credential: TURN_TEST_PASSWORD,
            },
          ],
        });
        expect(ice.connection.turnServer).toEqual([turnHost, turnPort]);

        // Act: setLocalDescription が gathering を起動する（チケット Usage と同じ順序）
        await pc.setLocalDescription(offer);

        // Assert: gathering 完了し、stage した TURN から relay candidate が実際に出る
        expect(ice.gatheringState).toBe("complete");
        expect(pc.iceGatheringState).toBe("complete");
        const relayCandidates = ice.localCandidates.filter(
          (candidate) => candidate.type === "relay",
        );
        expect(relayCandidates.length).toBeGreaterThan(0);
        // relay-only ポリシーなので host は出さず relay のみ
        expect(
          ice.localCandidates.every((candidate) => candidate.type === "relay"),
        ).toBe(true);
        // 認証に使った TURN が Connection に残っている（残滓クリアの逆方向）
        expect(ice.connection.options.turnUsername).toBe(TURN_TEST_USERNAME);
        expect(ice.connection.options.turnPassword).toBe(TURN_TEST_PASSWORD);
      } finally {
        await pc.close();
        await turnServer.close();
      }
    }, 20_000);

    test("TURN A → STUN only で Connection 上の TURN residual が消える", async () => {
      // Arrange: TURN A で PeerConnection を構築
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "turn:turn-a.example.com:3478",
            username: "user-a",
            credential: "pass-a",
          },
        ],
      });
      try {
        pc.createDataChannel("residual");
        await pc.createOffer();
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        expect(ice.connection.turnServer).toEqual(["turn-a.example.com", 3478]);

        // Act: STUN only に置換
        pc.setConfiguration({
          iceServers: [{ urls: "stun:stun.example.com:19302" }],
        });

        // Assert: TURN A の server / credential が残らない
        expect(ice.connection.turnServer).toBeUndefined();
        expect(ice.connection.options.turnUsername).toBeUndefined();
        expect(ice.connection.options.turnPassword).toBeUndefined();
        expect(ice.connection.stunServer).toEqual(["stun.example.com", 19302]);
      } finally {
        await pc.close();
      }
    });

    test("TURN A → TURN B で Connection 上の server / credential が置換される", async () => {
      // Arrange
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "turn:turn-a.example.com:3478",
            username: "user-a",
            credential: "pass-a",
          },
        ],
      });
      try {
        pc.createDataChannel("replace");
        await pc.createOffer();
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;

        // Act
        pc.setConfiguration({
          iceServers: [
            {
              urls: "turn:turn-b.example.com:5349?transport=tcp",
              username: "user-b",
              credential: "pass-b",
            },
          ],
        });

        // Assert
        expect(ice.connection.turnServer).toEqual(["turn-b.example.com", 5349]);
        expect(ice.connection.options.turnUsername).toBe("user-b");
        expect(ice.connection.options.turnPassword).toBe("pass-b");
        expect(ice.connection.options.turnTransport).toBe("tcp");
      } finally {
        await pc.close();
      }
    });

    test("gathering 完了後の setConfiguration は live Connection を更新せず restart を要求する", async () => {
      // Arrange: gather 完了まで進める
      const pc = new RTCPeerConnection({ iceServers: [] });
      try {
        pc.createDataChannel("post-gather");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(ice.gatheringState).toBe("complete");
        expect(pc.iceGatheringState).toBe("complete");
        expect(ice.connection.turnServer).toBeUndefined();

        // Act: gathering 完了後に TURN を設定
        pc.setConfiguration({
          iceServers: [
            {
              urls: "turn:turn.example.com:3478",
              username: "late-user",
              credential: "late-pass",
            },
          ],
        });

        // Assert: PeerConfig には入るが live Connection は触らない
        // （次の ICE restart で新しい設定を使う）
        expect(pc.getConfiguration().iceServers).toEqual([
          {
            urls: "turn:turn.example.com:3478",
            username: "late-user",
            credential: "late-pass",
          },
        ]);
        expect(ice.connection.turnServer).toBeUndefined();
        expect(ice.connection.options.turnUsername).toBeUndefined();
        // Assert: JSEP 4.1.18 の needs-ice-restart ビットが立つ
        expect((pc as any).needRestart).toBe(true);
      } finally {
        await pc.close();
      }
    });

    test("gathering 完了後に 2 番目以降の iceServers を追加・変更すると restart を要求する", async () => {
      // Arrange: TURN A のみで gather 完了まで進める
      const turnA = {
        urls: "turn:turn-a.example.com:3478",
        username: "user-a",
        credential: "pass-a",
      };
      const turnB = {
        urls: "turn:turn-b.example.com:3478",
        username: "user-b",
        credential: "pass-b",
      };
      const pc = new RTCPeerConnection({ iceServers: [turnA] });
      try {
        pc.createDataChannel("second-server");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(ice.gatheringState).toBe("complete");

        // Act: 先頭の TURN A を維持したまま TURN B を追加する
        pc.setConfiguration({ iceServers: [turnA, turnB] });

        // Assert: transport が使うのは先頭のサーバーだけだが、restart は要求される
        expect((pc as any).needRestart).toBe(true);

        // Arrange: ビットを下ろして同じリストを再設定する
        (pc as any).needRestart = false;

        // Act: 変更のない [A, B] を再設定する
        pc.setConfiguration({ iceServers: [turnA, turnB] });

        // Assert: 同一リストなので restart は要求されない
        expect((pc as any).needRestart).toBe(false);

        // Act: 2 番目の TURN B の credential だけを変更する
        pc.setConfiguration({
          iceServers: [turnA, { ...turnB, credential: "pass-b2" }],
        });

        // Assert: 後続要素の変更でも restart は要求される
        expect((pc as any).needRestart).toBe(true);
      } finally {
        await pc.close();
      }
    });

    test("gathering 完了後に turnTransport / turnTlsOptions / iceUseTcp だけ変更しても defer され restart を要求する", async () => {
      // Arrange: TURN 付きで gather 完了まで進める
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "turn:turn.example.com:3478",
            username: "u",
            credential: "p",
          },
        ],
      });
      try {
        pc.createDataChannel("other-fields");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(ice.gatheringState).toBe("complete");
        const changes: Parameters<RTCPeerConnection["setConfiguration"]>[0][] =
          [
            { turnTransport: "tcp" },
            { turnTlsOptions: { rejectUnauthorized: false } },
            { iceUseTcp: true },
          ];

        for (const change of changes) {
          (pc as any).needRestart = false;

          // Act: 1 フィールドだけ変更する
          pc.setConfiguration(change);

          // Assert: restart が要求され、live Connection は変わらない
          expect((pc as any).needRestart).toBe(true);
        }
        expect(ice.connection.options.useTcp).toBeFalsy();

        // Act: restart で次の gathering に入る
        await ice.restart();

        // Assert: restart 後は変更した設定が Connection に適用される
        expect(ice.connection.options.turnTransport).toBe("tcp");
        expect(ice.connection.options.turnTlsOptions).toEqual({
          rejectUnauthorized: false,
        });
        expect(ice.connection.options.useTcp).toBe(true);
      } finally {
        await pc.close();
      }
    });

    test("turnTlsOptions / turnUdpFamily / turnTransport に undefined を明示すると解除され、次の gathering に反映される", async () => {
      // Arrange: TLS 設定付きの TURN で gather 完了まで進める
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "turns:turn.example.com:5349",
            username: "u",
            credential: "p",
          },
        ],
        turnTransport: "tls",
        turnTlsOptions: { rejectUnauthorized: false },
        turnUdpFamily: 4,
      });
      try {
        pc.createDataChannel("clear-turn-options");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(pc.getConfiguration().turnTlsOptions).toBeDefined();

        // Act: 省略した setConfiguration では値が維持される
        pc.setConfiguration({ iceUseTcp: false });

        // Assert: 省略なら変更なし
        expect(pc.getConfiguration().turnTlsOptions).toEqual({
          rejectUnauthorized: false,
        });
        expect(pc.getConfiguration().turnUdpFamily).toBe(4);
        expect((pc as any).needRestart).toBe(false);

        // Act: undefined を明示して解除し、ICE restart する
        pc.setConfiguration({
          turnTransport: undefined,
          turnTlsOptions: undefined,
          turnUdpFamily: undefined,
        });

        // Assert: 設定が解除され、restart が要求される
        expect(pc.getConfiguration().turnTlsOptions).toBeUndefined();
        expect(pc.getConfiguration().turnUdpFamily).toBeUndefined();
        expect((pc as any).needRestart).toBe(true);

        // Act: 次の gathering に入る
        ice.restart();

        // Assert: Connection の古い TLS / family が残らない
        expect(ice.connection.options.turnTlsOptions).toBeUndefined();
        expect(ice.connection.options.turnUdpFamily).toBeUndefined();
      } finally {
        await pc.close();
      }
    });

    test("gathering 完了後に同じ iceServers を再設定しても restart を要求しない", async () => {
      // Arrange: gather 完了まで進める
      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: "turn:turn.example.com:3478",
            username: "same-user",
            credential: "same-pass",
          },
        ],
      });
      try {
        pc.createDataChannel("same-config");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(ice.gatheringState).toBe("complete");

        // Act: 現在の設定をそのまま再設定する
        pc.setConfiguration(pc.getConfiguration());

        // Assert: 設定は変わっていないので restart は要求されない
        expect((pc as any).needRestart).toBe(false);
      } finally {
        await pc.close();
      }
    });

    test("ICE restart 後 gatheringState が new なら setConfiguration が反映される", async () => {
      // Arrange: 一度 gather 完了 → restart
      // setGatheringState 経由で manager 集約も new に戻る
      const pc = new RTCPeerConnection({ iceServers: [] });
      try {
        pc.createDataChannel("restart-sync");
        const ice = (pc as any).secureManager
          .iceTransports[0] as RTCIceTransport;
        await ice.gather();
        expect(pc.iceGatheringState).toBe("complete");

        // Act: ICE restart（gatherer は new、manager 集約も追従する）
        (pc as any).secureManager.restartIce();
        expect(ice.gatheringState).toBe("new");
        expect(pc.iceGatheringState).toBe("new");

        // Act: restart 直後（まだ gather していない）に setConfiguration
        pc.setConfiguration({
          iceServers: [
            {
              urls: "turn:post-restart.example.com:3478",
              username: "post",
              credential: "restart",
            },
          ],
        });

        // Assert: gatheringState new なので TURN が stage される（needRestart は立てない）
        expect(ice.connection.turnServer).toEqual([
          "post-restart.example.com",
          3478,
        ]);
        expect(ice.connection.options.turnUsername).toBe("post");
        expect((pc as any).needRestart).toBe(false);
      } finally {
        await pc.close();
      }
    });
  });

  describe("TURN credential rotation (setConfiguration + ICE restart)", () => {
    let servers: Awaited<ReturnType<typeof createTurnRotationServers>>;
    const peers: RTCPeerConnection[] = [];

    beforeEach(async () => {
      servers = await createTurnRotationServers();
    });
    afterEach(async () => {
      await Promise.all(peers.splice(0).map((pc) => pc.close()));
      await servers.close();
    });

    /** Arrange: credential A の TURN を持つ offerer と STUN のみの answerer を接続する */
    async function connectWithTurnA() {
      const offerer = new RTCPeerConnection({
        iceServers: servers.iceServers("a"),
      });
      const answerer = new RTCPeerConnection({
        iceServers: servers.iceServers(),
      });
      peers.push(offerer, answerer);
      await connectPeerConnections(offerer, answerer);
      const [staleAllocation] = peerTurnAllocations(offerer);
      expect(staleAllocation).toBeDefined();
      return {
        offerer,
        answerer,
        staleAllocation,
        closeStale: vi.spyOn(staleAllocation, "close"),
        staleRelayPort: staleAllocation.localCandidate.port,
        authenticatedBefore: servers.turn.authenticatedUsernames.length,
      };
    }

    test("setConfiguration(TURN B) → restartIce() → createOffer() で credential B の allocation になる", async () => {
      // Arrange
      const arranged = await connectWithTurnA();
      const { offerer, answerer } = arranged;
      const { ice, connection } = firstIceTransport(offerer);
      const ufragBefore = ice.localParameters.usernameFragment;

      // Act: credential B に差し替えて ICE restart を交渉する
      offerer.setConfiguration({ iceServers: servers.iceServers("b") });
      offerer.restartIce();
      await negotiate(offerer, answerer);
      await waitForLocalCandidatesEnd(offerer);

      // Assert: restart 後の TURN 認証はすべて credential B
      const authenticated = servers.authenticatedSince(
        arranged.authenticatedBefore,
      );
      expect(authenticated.length).toBeGreaterThan(0);
      expect(new Set(authenticated)).toEqual(
        new Set([servers.credentials.b.username]),
      );
      // Assert: 旧 allocation は close され、新 generation の relay は新しい allocation のもの
      expect(arranged.closeStale).toHaveBeenCalled();
      const allocations = peerTurnAllocations(offerer);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).not.toBe(arranged.staleAllocation);
      const relay = connection.localCandidates.filter(
        (candidate) => candidate.type === "relay",
      );
      expect(relay).toHaveLength(1);
      expect(relay[0].port).not.toBe(arranged.staleRelayPort);
      expect(relay[0].ufrag).toBe(connection.localUsername);
      expect(ice.localParameters.usernameFragment).not.toBe(ufragBefore);
      expect(connection.options.turnUsername).toBe(
        servers.credentials.b.username,
      );
    }, 30_000);

    test("restartIce() なしでも gathering 後の setConfiguration → createOffer で 1 回だけ restart する", async () => {
      // Arrange
      const arranged = await connectWithTurnA();
      const { offerer, answerer } = arranged;
      const { ice } = firstIceTransport(offerer);
      const ufragBefore = ice.localParameters.usernameFragment;
      const restartsBefore = ice.iceRestarts;
      const negotiationNeeded = vi.fn();
      offerer.onNegotiationneeded.subscribe(negotiationNeeded);

      // Act: setConfiguration だけで needs-ice-restart が立つ
      offerer.setConfiguration({ iceServers: servers.iceServers("b") });

      // Assert: restart が要求されるが、それだけでは negotiationneeded は発火しない
      expect((offerer as any).needRestart).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(negotiationNeeded).not.toHaveBeenCalled();

      // Act: 次の offer / answer を交渉する
      await negotiate(offerer, answerer);
      await waitForLocalCandidatesEnd(offerer);

      // Assert: ufrag が変わり、restart は 1 回だけで要求は解消される
      expect(ice.localParameters.usernameFragment).not.toBe(ufragBefore);
      expect(ice.iceRestarts - restartsBefore).toBe(1);
      expect((offerer as any).needRestart).toBe(false);
      // Assert: 新しい allocation は credential B で認証される
      const authenticated = servers.authenticatedSince(
        arranged.authenticatedBefore,
      );
      expect(authenticated.length).toBeGreaterThan(0);
      expect(new Set(authenticated)).toEqual(
        new Set([servers.credentials.b.username]),
      );
      expect(arranged.closeStale).toHaveBeenCalled();

      // Act: もう一度 offer / answer を交渉する
      const ufragAfterRestart = ice.localParameters.usernameFragment;
      await negotiate(offerer, answerer);

      // Assert: 追加の restart は起きない
      expect(ice.localParameters.usernameFragment).toBe(ufragAfterRestart);
      expect(ice.iceRestarts - restartsBefore).toBe(1);
    }, 30_000);

    test("TURN A → STUN のみ: restart 後の generation に relay 候補が出ず TURN 設定が消える", async () => {
      // Arrange
      const arranged = await connectWithTurnA();
      const { offerer, answerer } = arranged;
      const { connection } = firstIceTransport(offerer);

      // Act: TURN を外して ICE restart を交渉する
      offerer.setConfiguration({ iceServers: servers.iceServers() });
      offerer.restartIce();
      await negotiate(offerer, answerer);
      await waitForLocalCandidatesEnd(offerer);

      // Assert: TURN server / credential がクリアされ、STUN server は残る
      expect(connection.turnServer).toBeUndefined();
      expect(connection.options.turnUsername).toBeUndefined();
      expect(connection.options.turnPassword).toBeUndefined();
      expect(connection.stunServer).toBeDefined();
      // Assert: 旧 allocation は close され、新 generation に relay 候補は無い
      expect(arranged.closeStale).toHaveBeenCalled();
      expect(peerTurnAllocations(offerer)).toHaveLength(0);
      expect(
        connection.localCandidates.filter(
          (candidate) => candidate.type === "relay",
        ),
      ).toHaveLength(0);
      expect(servers.authenticatedSince(arranged.authenticatedBefore)).toEqual(
        [],
      );
    }, 30_000);

    test("TURN A → 別の TURN server: restart 後は新しい server の allocation だけになる", async () => {
      // Arrange: 置換先の TURN server を別に用意する
      const arranged = await connectWithTurnA();
      const { offerer, answerer } = arranged;
      const { connection } = firstIceTransport(offerer);
      const otherServers = await createTurnRotationServers();
      try {
        // Act: 別 server の TURN に差し替えて ICE restart を交渉する
        offerer.setConfiguration({ iceServers: otherServers.iceServers("b") });
        offerer.restartIce();
        await negotiate(offerer, answerer);
        await waitForLocalCandidatesEnd(offerer);

        // Assert: 旧 server の allocation は close され、新しい server に credential B で allocation される
        expect(arranged.closeStale).toHaveBeenCalled();
        const allocations = peerTurnAllocations(offerer);
        expect(allocations).toHaveLength(1);
        expect(allocations[0].turn.server).toEqual(otherServers.turn.address);
        expect(otherServers.turn.authenticatedUsernames).toContain(
          otherServers.credentials.b.username,
        );
        expect(
          servers.authenticatedSince(arranged.authenticatedBefore),
        ).toEqual([]);
        expect(
          connection.localCandidates.filter(
            (candidate) => candidate.type === "relay",
          ),
        ).toHaveLength(1);
      } finally {
        await Promise.all(peers.splice(0).map((pc) => pc.close()));
        await otherServers.close();
      }
    }, 30_000);

    test("相手側起点の ICE restart でも answerer は最新の iceServers で gather する", async () => {
      // Arrange: credential A の TURN を持つ answerer と STUN のみの offerer を接続する
      const offerer = new RTCPeerConnection({
        iceServers: servers.iceServers(),
      });
      const answerer = new RTCPeerConnection({
        iceServers: servers.iceServers("a"),
      });
      peers.push(offerer, answerer);
      await connectPeerConnections(offerer, answerer);
      const [staleAllocation] = peerTurnAllocations(answerer);
      const closeStale = vi.spyOn(staleAllocation, "close");
      const authenticatedBefore = servers.turn.authenticatedUsernames.length;

      // Act: answerer は setConfiguration だけ行い、offerer が ICE restart を起こす
      answerer.setConfiguration({ iceServers: servers.iceServers("b") });
      offerer.restartIce();
      await negotiate(offerer, answerer);
      await waitForLocalCandidatesEnd(answerer);

      // Assert: answerer の新しい allocation は credential B で認証され、旧 allocation は close される
      const authenticated = servers.authenticatedSince(authenticatedBefore);
      expect(authenticated.length).toBeGreaterThan(0);
      expect(new Set(authenticated)).toEqual(
        new Set([servers.credentials.b.username]),
      );
      expect(closeStale).toHaveBeenCalled();
      const allocations = peerTurnAllocations(answerer);
      expect(allocations).toHaveLength(1);
      expect(allocations[0]).not.toBe(staleAllocation);
    }, 30_000);
  });

  describe("turnUdpFamily", () => {
    test("PeerConfig.turnUdpFamily が Connection の turnUdpFamily に伝搬する", async () => {
      // Arrange
      const { pc, ice } = createPeerConnectionWithIceTransport({
        turnUdpFamily: 6,
      });
      try {
        // Act: RTCIceGatherer が生成した Connection のオプションを読む
        const { turnUdpFamily } = ice.connection.options;

        // Assert: 指定した family がそのまま IceOptions に渡っている
        expect(turnUdpFamily).toBe(6);
      } finally {
        await pc.close();
      }
    });

    test("収集前の setConfiguration で turnUdpFamily だけを更新しても Connection に反映される", async () => {
      // Arrange: turnUdpFamily 未指定の PeerConnection (transport は収集前)
      const { pc, ice } = createPeerConnectionWithIceTransport();
      try {
        // Act: iceServers を変えず family だけを更新する
        pc.setConfiguration({ iceServers: [], turnUdpFamily: 6 });

        // Assert: 設定値と、既に生成済みの Connection の両方が 6 になる
        expect(pc.getConfiguration().turnUdpFamily).toBe(6);
        expect(ice.connection.options.turnUdpFamily).toBe(6);
      } finally {
        await pc.close();
      }
    });

    test("収集前の setConfiguration で iceServers と一緒に指定した turnUdpFamily が Connection に反映される", async () => {
      // Arrange
      const { pc, ice } = createPeerConnectionWithIceTransport();
      try {
        // Act: TURN と family を同時に更新する
        pc.setConfiguration({
          iceServers: [
            {
              urls: "turn:turn.example.com:3478",
              username: "u",
              credential: "p",
            },
          ],
          turnUdpFamily: 6,
        });

        // Assert: TURN サーバと family が Connection に反映される
        expect(ice.connection.options.turnServer).toEqual([
          "turn.example.com",
          3478,
        ]);
        expect(ice.connection.options.turnUdpFamily).toBe(6);
      } finally {
        await pc.close();
      }
    });

    test("turnUdpFamily 未指定なら undefined のまま (既定 udp4)", async () => {
      // Arrange
      const { pc, ice } = createPeerConnectionWithIceTransport();
      try {
        // Act: RTCIceGatherer が生成した Connection のオプションを読む
        const { turnUdpFamily } = ice.connection.options;

        // Assert: 既定値は undefined で、ice 層の既定 (udp4) に委ねられる
        expect(turnUdpFamily).toBeUndefined();
      } finally {
        await pc.close();
      }
    });
  });

  test("consent expiry 後の ICE transport restart で新 credentials により再接続できる", async () => {
    // Arrange: host のみの ICE transport pair
    const [transport1, transport2] = await iceTransportPair();
    try {
      expect(transport1.state).toBe("connected");
      expect(transport2.state).toBe("connected");
      const oldUfrag = transport1.connection.localUsername;
      const oldSession = (transport1.connection as any).consentSessionId;

      // Act: consent 失効相当
      (transport1.connection as any).stopConsentLifecycle?.();
      (transport1.connection as any).setState("failed");
      expect(transport1.state).toBe("failed");

      // Act: 両端 restart → 再 gather / 再 start
      transport1.restart();
      transport2.restart();
      expect(transport1.connection.localUsername).not.toBe(oldUfrag);

      await Promise.all([transport1.gather(), transport2.gather()]);
      transport2.localCandidates.forEach(transport1.addRemoteCandidate);
      transport1.localCandidates.forEach(transport2.addRemoteCandidate);
      transport1.setRemoteParams(transport2.localParameters);
      transport2.setRemoteParams(transport1.localParameters);
      await Promise.all([transport1.start(), transport2.start()]);

      // Assert: 新 credentials で connected に復帰
      expect(transport1.state).toBe("connected");
      expect(transport2.state).toBe("connected");
      expect((transport1.connection as any).consentFresh).toBe(true);
      expect((transport1.connection as any).consentSessionId).toBeGreaterThan(
        oldSession ?? 0,
      );

      // Assert: 新 selected pair で application data を送れる
      const recv = transport2.connection.onData.asPromise();
      await transport1.connection.send(Buffer.from("post-restart"));
      expect((await recv)[0].toString()).toBe("post-restart");
    } finally {
      await Promise.all([transport1.stop(), transport2.stop()]);
    }
  }, 20_000);

  test("test_connect", async () => {
    const gatherer1 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
    });
    const transport1 = new RTCIceTransport(gatherer1);
    transport1.connection.iceControlling = true;

    const gatherer2 = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
    });
    const transport2 = new RTCIceTransport(gatherer2);
    transport2.connection.iceControlling = false;

    expect(transport1.state).toBe("new");
    expect(transport2.state).toBe("new");

    await Promise.all([gatherer1.gather(), gatherer2.gather()]);

    expect(transport1.state).toBe("completed");
    expect(transport2.state).toBe("completed");

    gatherer2.localCandidates.forEach(transport1.addRemoteCandidate);
    gatherer1.localCandidates.forEach(transport2.addRemoteCandidate);

    transport1.setRemoteParams(gatherer2.localParameters);
    transport2.setRemoteParams(gatherer1.localParameters);
    await Promise.all([transport1.start(), transport2.start()]);
    expect(transport1.state).toBe("connected");
    expect(transport2.state).toBe("connected");

    await Promise.all([transport1.stop(), transport2.stop()]);
    expect(transport1.state).toBe("closed");
    expect(transport2.state).toBe("closed");
  });

  test("gather includes TCP host candidates when enabled", async () => {
    const gatherer = new RTCIceGatherer({
      useTcp: true,
      useIpv6: false,
      stunServer: undefined,
    });

    try {
      await gatherer.gather();

      // Assert: opt-in 時だけ IPv4 アドレスごとの active / passive TCP host candidate が公開される。
      const tcpCandidates = gatherer.localCandidates.filter(
        (candidate) => candidate.protocol === "tcp",
      );
      expect(tcpCandidates.map((candidate) => candidate.tcpType)).toContain(
        "active",
      );
      expect(tcpCandidates.map((candidate) => candidate.tcpType)).toContain(
        "passive",
      );
      expect(
        tcpCandidates.every(
          (candidate) =>
            candidate.type === "host" &&
            (candidate.tcpType === "active"
              ? candidate.port === 9
              : candidate.tcpType === "passive" && candidate.port > 0),
        ),
      ).toBe(true);
    } finally {
      await gatherer.connection.close();
    }
  });

  test.skip("portRange", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44444, 44455],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(candidate.port >= 44444 && candidate.port < 44455).toBeTruthy();
    }
    await gatherer.connection.close();
  });

  test.skip("minimum target port", async () => {
    const gatherer = new RTCIceGatherer({
      stunServer: ["stun.l.google.com", 19302],
      portRange: [44546, 44547],
    });

    await gatherer.gather();

    const candidates = gatherer.localCandidates;
    for (const candidate of candidates) {
      expect(
        candidate.port >= 44546 && candidate.port < 44547 + 1,
      ).toBeTruthy();
    }
    await gatherer.connection.close();
  });

  test("getStats keeps candidate ids stable until restart and does not reuse them after restart", async () => {
    const gatherer = new RTCIceGatherer();
    const transport = new RTCIceTransport(gatherer);

    await gatherer.gather();

    // Act: restart 前に 2 回 stats を取り、同じ monitored object を確認する。
    const beforeRestart = await transport.getStats();
    const beforeRestartAgain = await transport.getStats();

    // Assert: restart 前は local candidate の id が安定している。
    const firstIds = beforeRestart
      .filter((stat) => stat.type === "local-candidate")
      .map((stat) => stat.id)
      .sort();
    const secondIds = beforeRestartAgain
      .filter((stat) => stat.type === "local-candidate")
      .map((stat) => stat.id)
      .sort();
    expect(secondIds).toEqual(firstIds);

    transport.restart();
    await gatherer.gather();

    // Act: restart 後の candidate id を取得する。
    const afterRestart = await transport.getStats();

    // Assert: restart 後は以前の id を再利用しない。
    const restartedIds = new Set(
      afterRestart
        .filter((stat) => stat.type === "local-candidate")
        .map((stat) => stat.id),
    );
    expect(firstIds.every((id) => !restartedIds.has(id))).toBe(true);

    await transport.stop();
  });

  test("getStats keeps candidate-pair ids stable until restart and does not reuse them after restart", async () => {
    const [transport1, transport2] = await iceTransportPair();

    // Act: restart 前に 2 回 stats を取り、同じ candidate-pair を確認する。
    const beforeRestart = await transport1.getStats();
    const beforeRestartAgain = await transport1.getStats();

    // Assert: restart 前は candidate-pair の id が安定している。
    const firstPairIds = beforeRestart
      .filter((stat) => stat.type === "candidate-pair")
      .map((stat) => stat.id)
      .sort();
    const secondPairIds = beforeRestartAgain
      .filter((stat) => stat.type === "candidate-pair")
      .map((stat) => stat.id)
      .sort();
    expect(firstPairIds.length).toBeGreaterThan(0);
    expect(secondPairIds).toEqual(firstPairIds);

    transport1.restart();
    transport2.restart();
    await Promise.all([transport1.gather(), transport2.gather()]);

    transport2.localCandidates.forEach(transport1.addRemoteCandidate);
    transport1.localCandidates.forEach(transport2.addRemoteCandidate);
    transport1.setRemoteParams(transport2.localParameters);
    transport2.setRemoteParams(transport1.localParameters);

    // Act: restart 後の candidate-pair id を取得する。
    const afterRestart = await transport1.getStats();

    // Assert: restart 後は以前の pair id を再利用しない。
    const restartedPairIds = new Set(
      afterRestart
        .filter((stat) => stat.type === "candidate-pair")
        .map((stat) => stat.id),
    );
    expect(firstPairIds.every((id) => !restartedPairIds.has(id))).toBe(true);

    await Promise.all([transport1.stop(), transport2.stop()]);
  });
});
