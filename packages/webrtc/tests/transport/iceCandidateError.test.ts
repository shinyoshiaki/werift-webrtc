import { setTimeout as delay } from "node:timers/promises";
import {
  createLocalTurnServer,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../../../ice/tests/utils";
import { RTCPeerConnectionIceErrorEvent } from "../../src";
import {
  type IceCandidateErrorDetails,
  RTCIceGatherer,
} from "../../src/transport/ice";
import { negotiate } from "../utils";
import {
  createCodelessErrorServer,
  createErrorRecordingPeer,
  createErrorStunServer,
  createFirstPortOnlyStunServer,
  createHostOnlyPeer,
  createRejectingUdpTurnServer,
  createScriptedUdpServer,
  createSilentUdpServer,
  createUnbundledPartlyReachablePeer,
  createUnbundledUnreachablePeer,
  errorResponse,
  errorSummaries,
  errorTestHost,
  gatheringComplete,
  gatherWithOffer,
  holdGathering,
  hostPortOf,
  useNoIceServers,
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
      expect(event).toBeInstanceOf(Event);
      expect(typeof event.preventDefault).toBe("function");
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

  test("サーバーの理由句は errorText として届く (診断情報)", async () => {
    // Arrange: 独自の理由句で 400 を返す STUN
    const stun = await createErrorStunServer(400, "Missing fingerprint");
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${stun.address[1]}` }],
    });
    try {
      // Act: offer を適用して gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: サーバーの理由句がそのまま届く
      expect(listened.map(({ errorText }) => errorText)).toEqual([
        "Missing fingerprint",
      ]);
    } finally {
      await pc.close();
      await stun.close();
    }
  });

  test("701 のハンドラー内では iceGatheringState が gathering で、complete は後の icegatheringstatechange から見える", async () => {
    // Arrange: 応答しない STUN。ハンドラー内とその後の状態を記録する
    const silent = await createSilentUdpServer(errorTestHost);
    const { pc } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${silent.address[1]}` }],
      iceStunGatherTimeout: 0.3,
    });
    const seen: string[] = [];
    pc.onicecandidateerror = (event) => {
      seen.push(`${event.errorCode}:${pc.iceGatheringState}`);
    };
    pc.addEventListener("icegatheringstatechange", () => {
      seen.push(`state:${pc.iceGatheringState}`);
    });
    try {
      // Act: offer を適用して gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: 701 は gathering 中に届き、その後で complete への変化が通知される
      expect(seen).toEqual([
        "state:gathering",
        "701:gathering",
        "state:complete",
      ]);
      expect(pc.iceGatheringState).toBe("complete");
    } finally {
      await pc.close();
      await silent.close();
    }
  });

  test("stopImmediatePropagation() を呼んだハンドラーの後のリスナーには配送されない", async () => {
    // Arrange: 400 を返す STUN と、1 番目で伝播を止める 2 つのリスナー
    const stun = await createErrorStunServer(400, "Bad Request");
    const { pc, handled } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${stun.address[1]}` }],
    });
    const calls: string[] = [];
    pc.addEventListener("icecandidateerror", (event) => {
      calls.push("first");
      (event as Event).stopImmediatePropagation();
    });
    pc.addEventListener("icecandidateerror", () => {
      calls.push("second");
    });
    try {
      // Act: offer を適用して gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: 先に登録されたハンドラーまでは届き、止めた後のリスナーは呼ばれない
      expect(handled).toHaveLength(1);
      expect(calls).toEqual(["first"]);
    } finally {
      await pc.close();
      await stun.close();
    }
  });

  test("応答はあったが STUN エラーコードのない STUN サーバーは 701 として通知されない", async () => {
    // Arrange: ERROR-CODE のないエラー応答を返す STUN
    const server = await createCodelessErrorServer();
    const { pc, listened, handled } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${server.address[1]}` }],
      iceStunGatherTimeout: 0.5,
    });
    try {
      // Act: offer を適用して gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: サーバーは応答したので未到達ではなく、イベントは出ない
      expect(server.requests.length).toBeGreaterThan(0);
      expect(listened).toEqual([]);
      expect(handled).toEqual([]);
    } finally {
      await pc.close();
      await server.close();
    }
  });

  test("標準 Event として振る舞う (継承・bubbles/cancelable・target 以外の既定値)", () => {
    // Arrange: init を渡して直接生成する
    // Act: イベントを生成する
    const event = new RTCPeerConnectionIceErrorEvent("icecandidateerror", {
      url: "stun:h",
      errorCode: 701,
      errorText: "x",
      cancelable: true,
    });
    event.preventDefault();

    // Assert: Event を継承し、type と cancelable が標準どおりに働く
    expect(event).toBeInstanceOf(Event);
    expect(event.type).toBe("icecandidateerror");
    expect(event.bubbles).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(event.address).toBeNull();
    expect(event.port).toBeNull();
  });

  test("先行するハンドラーが throw しても他の経路と残りの URL に通知される", async () => {
    // Arrange: 同じ STUN を指す 2 つの URL と、throw する 3 経路のハンドラー
    const stun = await createErrorStunServer(400, "Bad Request");
    const port = stun.address[1];
    const { pc, listened, handled } = createErrorRecordingPeer({
      iceServers: [
        {
          urls: [
            `stun:${errorTestHost}:${port}`,
            `stuns:${errorTestHost}:${port}`,
          ],
        },
      ],
    });
    const subscribed: RTCPeerConnectionIceErrorEvent[] = [];
    pc.onIceCandidateError.subscribe((event) => {
      subscribed.push(event);
      throw new Error("subscriber failed");
    });
    pc.onicecandidateerror = (event) => {
      handled.push(event);
      throw new Error("onicecandidateerror failed");
    };
    pc.addEventListener("icecandidateerror", () => {
      throw new Error("listener failed");
    });
    // 先行リスナーが throw しても後続リスナーが同じイベントを受け取ること
    const later: RTCPeerConnectionIceErrorEvent[] = [];
    pc.addEventListener("icecandidateerror", (event) => {
      later.push(event as RTCPeerConnectionIceErrorEvent);
    });
    const laterSubscribed: RTCPeerConnectionIceErrorEvent[] = [];
    pc.onIceCandidateError.subscribe((event) => {
      laterSubscribed.push(event);
    });
    try {
      // Act: gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: URL ごとに全経路へ届き、gathering は完了する
      expect(subscribed).toHaveLength(2);
      expect(handled).toHaveLength(2);
      expect(listened).toHaveLength(2);
      expect(later).toEqual(listened);
      expect(laterSubscribed).toEqual(subscribed);
      expect(pc.iceGatheringState).toBe("complete");
    } finally {
      await pc.close();
      await stun.close();
    }
  });

  test("複数のローカルソケットから同じ URL の 701 が届いても URL ごとに 1 回だけ通知される", () => {
    // Arrange: 同じ STUN への 701 を 2 つのローカルソケット分、別 URL の 701 と 400 を含めて流す
    const gatherer = new RTCIceGatherer({ useDefaultStunServer: false });
    const details: IceCandidateErrorDetails[] = [];
    gatherer.onIceCandidateError = (d: IceCandidateErrorDetails) =>
      details.push(d);
    const generation = gatherer.connection.generation;
    const server = (urls: string[]) => ({
      kind: "stun" as const,
      address: ["192.0.2.1", 3478] as [string, number],
      urls,
    });
    const info = (urls: string[], errorCode: number, address: string) => ({
      server: server(urls),
      address,
      port: 50000,
      errorCode,
      errorText: "x",
      generation,
    });

    // Act: ソケット 1 / ソケット 2 の失敗を順に通知する
    gatherer.connection.onIceCandidateError!.execute(
      info(["stun:a", "stuns:a"], 701, "10.0.0.1"),
    );
    gatherer.connection.onIceCandidateError!.execute(
      info(["stun:a", "stuns:a"], 701, "10.0.0.2"),
    );
    gatherer.connection.onIceCandidateError!.execute(
      info(["stun:b"], 701, "10.0.0.2"),
    );
    gatherer.connection.onIceCandidateError!.execute(
      info(["stun:a"], 400, "10.0.0.1"),
    );
    gatherer.connection.onIceCandidateError!.execute(
      info(["stun:a"], 400, "10.0.0.2"),
    );

    // Assert: 701 は URL ごとに 1 件、サーバーが返したエラー (400) はソケットごとに通知される
    expect(
      details.map(({ url, errorCode, address }) => ({
        url,
        errorCode,
        address,
      })),
    ).toEqual([
      { url: "stun:a", errorCode: 701, address: "10.0.0.1" },
      { url: "stuns:a", errorCode: 701, address: "10.0.0.1" },
      { url: "stun:b", errorCode: 701, address: "10.0.0.2" },
      { url: "stun:a", errorCode: 400, address: "10.0.0.1" },
      { url: "stun:a", errorCode: 400, address: "10.0.0.2" },
    ]);
  });

  test("配送中のイベントは target / currentTarget が RTCPeerConnection、eventPhase が AT_TARGET になる", async () => {
    // Arrange: 3 経路で配送中の値を記録する
    const stun = await createErrorStunServer(400, "Bad Request");
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [{ urls: `stun:${errorTestHost}:${stun.address[1]}` }],
    });
    type Seen = { target: unknown; currentTarget: unknown; eventPhase: number };
    const seen: Record<string, Seen> = {};
    const snapshot = (e: Event): Seen => ({
      target: e.target,
      currentTarget: e.currentTarget,
      eventPhase: e.eventPhase,
    });
    pc.onIceCandidateError.subscribe((e) => {
      seen.subscribe = snapshot(e);
    });
    pc.onicecandidateerror = (e) => {
      seen.handler = snapshot(e);
    };
    pc.addEventListener("icecandidateerror", (e) => {
      seen.listener = snapshot(e);
    });
    try {
      // Act: gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: どの経路でも配送元が接続で AT_TARGET、配送後は currentTarget が null
      for (const key of ["subscribe", "handler", "listener"]) {
        expect(seen[key]).toEqual({
          target: pc,
          currentTarget: pc,
          eventPhase: 2,
        });
      }
      expect(listened[0].target).toBe(pc);
      expect(listened[0].currentTarget).toBeNull();
      expect(listened[0].eventPhase).toBe(0);
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

  test("既定の STUN サーバー (設定にない) の失敗は合成した URL で通知される", async () => {
    // Arrange: STUN を設定せず既定の STUN を使い、応答より先に満了するほど短くする
    // (ネットワークの有無によらず、満了または DNS 失敗の 701 になる)
    const { pc, listened, handled } = createErrorRecordingPeer({
      iceServers: [],
      iceUseDefaultStunServer: true,
      iceStunGatherTimeout: 0.001,
    });
    try {
      // Act: gathering を完了させる
      await gatherWithOffer(pc);

      // Assert: 合成した URL・701・ホストアドレス付きで 1 件、両経路に同じイベントが届く
      expect(errorSummaries(listened)).toEqual([
        {
          url: "stun:stun.l.google.com:19302",
          errorCode: 701,
          errorText: expect.any(String),
          address: errorTestHost,
          port: expect.any(Number),
        },
      ]);
      expect(listened[0].port).toBeGreaterThan(0);
      expect(handled).toEqual(listened);
    } finally {
      await pc.close();
    }
  });

  test("bundle なしの複数 transport が同じ URL に到達できなくても 701 は 1 件だけ通知される", async () => {
    // Arrange: transport 2 個が同じ応答しない STUN を使う
    const { pc, listened, handled, url, silent } =
      await createUnbundledUnreachablePeer();
    try {
      // Act: 両 transport の gathering を完了させる
      await pc.setLocalDescription(await pc.createOffer());

      // Assert: transport は 2 個、URL ごとの 701 は 1 件で、両経路に同じイベント
      expect(pc.iceTransports).toHaveLength(2);
      expect(listened.map(({ url, errorCode }) => [url, errorCode])).toEqual([
        [url, 701],
      ]);
      expect(handled).toEqual(listened);
    } finally {
      await pc.close();
      await silent.close();
    }
  });

  test("bundle なしで一方の transport だけがサーバーに届いたときは 701 を通知しない", async () => {
    // Arrange: 最初に問い合わせた transport のソケットにだけ応答する STUN
    const {
      pc,
      listened,
      silent: server,
    } = await createUnbundledPartlyReachablePeer();
    try {
      // Act: 両 transport の gathering を完了させる
      await pc.setLocalDescription(await pc.createOffer());

      // Assert: transport は 2 個、srflx は得られ、701 は出ない
      expect(pc.iceTransports).toHaveLength(2);
      expect(pc.localDescription!.sdp).toContain("typ srflx");
      expect(listened).toEqual([]);
    } finally {
      await pc.close();
      await server.close();
    }
  });

  test("以前の gathering でサーバーに届いた transport は、再交渉で追加した transport の 701 を妨げない", async () => {
    // Arrange: 最初に問い合わせたポート (既存の音声 transport) にだけ応答する STUN で接続する
    const server = await createFirstPortOnlyStunServer();
    const url = `stun:${errorTestHost}:${server.address[1]}`;
    const { pc, listened } = createErrorRecordingPeer({
      bundlePolicy: "disable",
      iceServers: [{ urls: url }],
      iceStunGatherTimeout: 0.3,
    });
    const peer = createHostOnlyPeer();
    try {
      pc.addTransceiver("audio");
      await negotiate(pc, peer);
      const afterFirstGathering = listened.length;

      // Act: 映像 transceiver を追加して再交渉し、新しい transport だけが gathering する
      pc.addTransceiver("video");
      await negotiate(pc, peer);
      await gatheringComplete(pc);

      // Assert: 最初の gathering では届いたので 0 件、新しい transport の 701 が 1 件届く
      expect(afterFirstGathering).toBe(0);
      expect(pc.iceTransports).toHaveLength(2);
      expect(
        listened.map(({ url, errorCode, port }) => [url, errorCode, port]),
      ).toEqual([[url, 701, hostPortOf(pc.iceTransports[1])]]);
    } finally {
      await pc.close();
      await peer.close();
      await server.close();
    }
  });

  test("接続後に setConfiguration で加えた到達不能なサーバーは、追加した transport からも通知される", async () => {
    // Arrange: bundle なしで音声 transport だけで接続し、到達不能な STUN を設定に加える
    const silent = await createSilentUdpServer(errorTestHost);
    const url = `stun:${errorTestHost}:${silent.address[1]}`;
    const { pc, listened } = createErrorRecordingPeer({
      bundlePolicy: "disable",
      iceServers: [],
      iceStunGatherTimeout: 0.3,
    });
    const peer = createHostOnlyPeer();
    try {
      pc.addTransceiver("audio");
      await negotiate(pc, peer);
      pc.setConfiguration({
        ...pc.getConfiguration(),
        iceServers: [{ urls: url }],
      });

      // Act: 映像 transceiver を追加して再交渉し (既存 transport は ICE restart する)、gathering を完了させる
      pc.addTransceiver("video");
      await negotiate(pc, peer);
      await gatheringComplete(pc);

      // Assert: 新しいサーバーの 701 だけが届き、新しい transport の失敗も欠落しない
      expect(pc.iceTransports).toHaveLength(2);
      expect(listened.length).toBeGreaterThan(0);
      for (const event of listened) {
        expect([event.url, event.errorCode]).toEqual([url, 701]);
      }
      expect(listened.map(({ port }) => port)).toContain(
        hostPortOf(pc.iceTransports[1]),
      );
    } finally {
      await pc.close();
      await peer.close();
      await silent.close();
    }
  });

  test("進行中の gathering に後から加わった transport がサーバーに届いたときも 701 を通知しない", async () => {
    // Arrange: 2 番目に問い合わせたポート (後から gathering を始めた transport) にだけ応答する STUN
    const {
      pc,
      listened,
      silent: server,
    } = await createUnbundledPartlyReachablePeer(1);
    try {
      // Act: 両 transport の gathering を完了させる
      await pc.setLocalDescription(await pc.createOffer());

      // Assert: 先に始めた transport は届かないが、後の transport が届いたので 701 は出ない
      expect(pc.iceTransports).toHaveLength(2);
      expect(pc.localDescription!.sdp).toContain("typ srflx");
      expect(listened).toEqual([]);
    } finally {
      await pc.close();
      await server.close();
    }
  });

  test("gathering 中に結果を出さずに抜けた transport は、他の transport の 701 を妨げない", async () => {
    // Arrange: bundle なし 2 transport と応答しない STUN。映像 transport は収集を始めたまま止めておく
    const { pc, listened, url, silent } =
      await createUnbundledUnreachablePeer();
    const offer = await pc.createOffer();
    const [audio, video] = pc.iceTransports;
    const release = holdGathering(video);
    try {
      const applying = pc.setLocalDescription(offer);
      await delay(800);

      // Act: 音声 transport が 701 で失敗した後に、映像 transport を結果なしで止める
      await video.stop();
      release();
      await applying;
      await gatheringComplete(pc);

      // Assert: 抜けた transport は判定から外れ、音声 transport の 701 が 1 件届く
      expect(
        listened.map(({ url, errorCode, port }) => [url, errorCode, port]),
      ).toEqual([[url, 701, hostPortOf(audio)]]);
    } finally {
      release();
      await pc.close();
      await silent.close();
    }
  });

  test("その URL を試さなかった transport は、試して届かなかった transport の 701 を妨げない", async () => {
    // Arrange: bundle なし 2 transport と応答しない STUN。映像 transport だけ STUN を使わない構成にする
    const { pc, listened, url, silent } =
      await createUnbundledUnreachablePeer();
    const offer = await pc.createOffer();
    const [audio, video] = pc.iceTransports;
    useNoIceServers(video);
    try {
      // Act: 両 transport の gathering を完了させる
      await pc.setLocalDescription(offer);

      // Assert: URL を試したのは音声 transport だけで、その 701 が 1 件届く
      expect(
        listened.map(({ url, errorCode, port }) => [url, errorCode, port]),
      ).toEqual([[url, 701, hostPortOf(audio)]]);
    } finally {
      await pc.close();
      await silent.close();
    }
  });

  test("ICE restart の新しい gathering では同じ URL の 701 が再び 1 件通知される", async () => {
    // Arrange: bundle なし 2 transport で最初の gathering を終え、相手と接続情報を交換する
    const { pc, listened, url, silent } =
      await createUnbundledUnreachablePeer();
    const peer = createHostOnlyPeer();
    try {
      await negotiate(pc, peer);
      const firstGathering = listened.length;

      // Act: ICE restart して再び gathering を完了させる
      pc.restartIce();
      await negotiate(pc, peer);
      await gatheringComplete(pc);

      // Assert: gathering ごとに 1 件ずつ、計 2 件
      expect(firstGathering).toBe(1);
      expect(listened.map(({ url, errorCode }) => [url, errorCode])).toEqual([
        [url, 701],
        [url, 701],
      ]);
    } finally {
      await pc.close();
      await peer.close();
      await silent.close();
    }
  });

  test("最初の 701 のハンドラーで close() すると、残りの URL の 701 と gathering 状態の変化は配送されない", async () => {
    // Arrange: 応答しない STUN を 2 つ (701 が 2 URL)。最初の通知で close() する
    const first = await createSilentUdpServer(errorTestHost);
    const second = await createSilentUdpServer(errorTestHost);
    const { pc, listened } = createErrorRecordingPeer({
      iceServers: [
        { urls: `stun:${errorTestHost}:${first.address[1]}` },
        { urls: `stun:${errorTestHost}:${second.address[1]}` },
      ],
      iceStunGatherTimeout: 0.3,
    });
    const seenStates: string[] = [];
    pc.onicecandidateerror = () => {
      seenStates.push(pc.signalingState);
      void pc.close();
    };
    const gatheringStatesAfterClose: string[] = [];
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.signalingState === "closed") {
        gatheringStatesAfterClose.push(pc.iceGatheringState);
      }
    });
    try {
      // Act: gathering を終わらせ、最初の 701 のハンドラーで閉じる
      await gatherWithOffer(pc).catch(() => undefined);
      await delay(100);

      // Assert: ハンドラーは閉じる前の 1 回だけ、同じイベントの listener も 1 件、閉じた後の状態変化はない
      expect(seenStates).toEqual(["have-local-offer"]);
      expect(listened).toHaveLength(1);
      expect(listened[0].errorCode).toBe(701);
      expect(gatheringStatesAfterClose).toEqual([]);
    } finally {
      await pc.close();
      await first.close();
      await second.close();
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
