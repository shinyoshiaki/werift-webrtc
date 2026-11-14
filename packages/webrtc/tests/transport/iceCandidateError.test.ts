import { setTimeout as delay } from "node:timers/promises";
import {
  createLocalTurnServer,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../../../ice/tests/utils";
import { RTCPeerConnectionIceErrorEvent } from "../../src";
import { negotiate } from "../utils";
import {
  createErrorRecordingPeer,
  createErrorStunServer,
  createHostOnlyPeer,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  createSilentUdpServer,
  errorResponse,
  errorSummaries,
  errorTestHost,
  gatherWithOffer,
} from "./iceCandidateErrorUtils";

describe("icecandidateerror", () => {
  test("addEventListener と onicecandidateerror が同じ RTCPeerConnectionIceErrorEvent を受け取る", async () => {
    // Arrange: Binding に 400 を返す STUN を設定する
    const stun = await createErrorStunServer(400, "Bad Request");
    const url = `stun:${errorTestHost}:${stun.address[1]}`;
    const { pc, listened, handled } = createErrorRecordingPeer({
      iceServers: [{ urls: url }],
    });
    try {
      // Act: offer を適用して gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: 1 件のイベントが両経路に同じオブジェクトで届き、設定した URL とローカルアドレスを持つ
      expect(listened).toHaveLength(1);
      expect(handled).toEqual(listened);
      expect(handled[0]).toBe(listened[0]);
      const [event] = listened;
      expect(event).toBeInstanceOf(RTCPeerConnectionIceErrorEvent);
      expect(event.type).toBe("icecandidateerror");
      expect(event).toMatchObject({
        url,
        errorCode: 400,
        errorText: "Bad Request",
        address: errorTestHost,
      });
      expect(event.port).toBeGreaterThan(0);
      expect(pc.iceGatheringState).toBe("complete");
    } finally {
      await pc.close();
      await stun.close();
    }
  });

  test("1 つの STUN を指す複数の URL (stun: と stuns:) は URL ごとに 1 件ずつ通知される", async () => {
    // Arrange
    const stun = await createErrorStunServer(500, "Server Error");
    const port = stun.address[1];
    const urls = [
      `stun:${errorTestHost}:${port}`,
      `STUNS:${errorTestHost}:${port}`,
    ];
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [{ urls }],
    });
    try {
      // Act
      await gatherWithOffer(pc);

      // Assert: scheme は小文字に正規化され、それぞれの URL で 1 件
      expect(listened.map(({ url }) => url).sort()).toEqual(
        [
          `stun:${errorTestHost}:${port}`,
          `stuns:${errorTestHost}:${port}`,
        ].sort(),
      );
    } finally {
      await pc.close();
      await stun.close();
    }
  });

  test("同じホストで transport の違う TURN は別々の URL で、credential だけ違う TURN は失敗した URL だけで通知される", async () => {
    // Arrange: UDP のみで 401 を返す TURN (TCP は拒否) と、正しい credential だけ通る TURN
    const rejecting = await createRejectingUdpTurnServer();
    const turn = await createLocalTurnServer(errorTestHost);
    const rejectingUdp = `turn:${errorTestHost}:${rejecting.address[1]}`;
    const rejectingTcp = `turn:${errorTestHost}:${rejecting.address[1]}?transport=tcp`;
    const goodUrl = `turn:${errorTestHost}:${turn.address![1]}`;
    const badUrl = `turn:${errorTestHost}:${turn.address![1]}?transport=udp`;
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [
        {
          urls: [rejectingUdp, rejectingTcp],
          username: TURN_TEST_USERNAME,
          credential: TURN_TEST_PASSWORD,
        },
        {
          urls: goodUrl,
          username: TURN_TEST_USERNAME,
          credential: TURN_TEST_PASSWORD,
        },
        {
          urls: badUrl,
          username: TURN_TEST_USERNAME,
          credential: "wrong-secret",
        },
      ],
    });
    try {
      // Act
      await gatherWithOffer(pc);

      // Assert: 失敗した 3 URL がそれぞれ 1 件。成功した URL は出ず、取り違えもない
      expect(errorSummaries(listened)).toEqual(
        [
          { url: badUrl, errorCode: 401 },
          { url: rejectingUdp, errorCode: 401 },
          { url: rejectingTcp, errorCode: 701 },
        ]
          .map((expected) => ({
            ...expected,
            errorText: expect.any(String),
            address: null,
            port: 0,
          }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      );
      expect(JSON.stringify(errorSummaries(listened))).not.toContain(
        "wrong-secret",
      );
      expect(pc.localDescription!.sdp).toContain("typ relay");
    } finally {
      await pc.close();
      await rejecting.close();
      await turn.close();
    }
  });

  test('iceTransportPolicy "relay" では address が null、port が 0 になる', async () => {
    // Arrange
    const rejecting = await createRejectingUdpTurnServer();
    const { pc, listened } = createErrorRecordingPeer({
      iceTransportPolicy: "relay",
      iceServers: [
        {
          urls: `turn:${errorTestHost}:${rejecting.address[1]}`,
          username: TURN_TEST_USERNAME,
          credential: TURN_TEST_PASSWORD,
        },
      ],
    });
    try {
      // Act
      await gatherWithOffer(pc);

      // Assert
      expect(listened).toHaveLength(1);
      expect(listened[0].address).toBeNull();
      expect(listened[0].port).toBe(0);
    } finally {
      await pc.close();
      await rejecting.close();
    }
  });

  test("turns: URL は ?transport=tcp を補った URL で通知される", async () => {
    // Arrange: DNS で解決できない turns: サーバー
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [
        { urls: " turns:turn.invalid:5349 ", username: "u", credential: "p" },
      ],
    });
    try {
      // Act
      await gatherWithOffer(pc);

      // Assert: 正規化した URL と 701
      expect(listened.map(({ url, errorCode }) => [url, errorCode])).toEqual([
        ["turns:turn.invalid:5349?transport=tcp", 701],
      ]);
    } finally {
      await pc.close();
    }
  });

  test("既定の STUN サーバー (設定にない URL) の失敗は通知されない", async () => {
    // Arrange: 既定の STUN を使い、満了を短くする
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [],
      iceUseDefaultStunServer: true,
      iceStunGatherTimeout: 0.2,
    });
    try {
      // Act
      await gatherWithOffer(pc);

      // Assert
      expect(listened).toEqual([]);
    } finally {
      await pc.close();
    }
  });

  test("close() の後は通知されない", async () => {
    // Arrange: 応答しない STUN を短い満了時間で使う
    const silent = await createSilentUdpServer(errorTestHost);
    const { pc, listened, handled } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${silent.address[1]}` }],
      iceStunGatherTimeout: 0.3,
    });
    try {
      pc.addTransceiver("audio");
      const offer = await pc.createOffer();
      const applying = pc.setLocalDescription(offer).catch(() => undefined);
      await delay(50);

      // Act: 満了前に close する
      await pc.close();
      await applying;
      await delay(400);

      // Assert
      expect(listened).toEqual([]);
      expect(handled).toEqual([]);
    } finally {
      await silent.close();
    }
  });

  test("ICE restart で置き換えられた世代の失敗は通知されず、新しい設定の URL だけが出る", async () => {
    // Arrange: 800ms 遅れてエラーを返す STUN (旧) と、すぐエラーを返す STUN (新)。
    // 旧 URL で ICE restart した世代を作る (restart の gathering は裏で続く)
    const slow = await createScriptedUdpServer(
      (request) => errorResponse(request, 400, "Bad Request"),
      { host: errorTestHost, delayMs: 800 },
    );
    const failing = await createErrorStunServer(500, "Server Error");
    const oldUrl = `stun:${errorTestHost}:${slow.address[1]}`;
    const newUrl = `stun:${errorTestHost}:${failing.address[1]}`;
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [],
      iceStunGatherTimeout: 3,
    });
    const peer = createHostOnlyPeer();
    try {
      pc.addTransceiver("audio");
      await negotiate(pc, peer);
      pc.setConfiguration({
        ...pc.getConfiguration(),
        iceServers: [{ urls: oldUrl }],
      });
      pc.restartIce();
      await negotiate(pc, peer);

      // Act: 旧 URL の応答 (800ms 後) より前に新しい設定で再度 ICE restart する
      pc.setConfiguration({
        ...pc.getConfiguration(),
        iceServers: [{ urls: newUrl }],
      });
      pc.restartIce();
      await negotiate(pc, peer);
      await delay(1200);

      // Assert: 旧 URL は応答を受けても通知されず、新しい URL だけが通知される
      expect(slow.requests.length).toBeGreaterThan(0);
      expect(listened.map(({ url, errorCode }) => [url, errorCode])).toEqual([
        [newUrl, 500],
      ]);
    } finally {
      await pc.close();
      await peer.close();
      await slow.close();
      await failing.close();
    }
  });
});
