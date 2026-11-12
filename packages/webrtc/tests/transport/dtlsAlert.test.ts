import { setTimeout } from "timers/promises";

import {
  AlertDesc,
  AlertLevel,
  RTCDtlsFingerprint,
  RTCDtlsParameters,
  RTCPeerConnection,
} from "../../src";
import {
  createDtlsSessions,
  dtlsTransportPair,
  mutateFingerprint,
  recordDtlsEvents,
  recordSentDtlsAlerts,
  waitForDtlsState,
  zeroSdpFingerprints,
} from "../fixture";
import { waitUntil } from "../utils";

describe("RTCDtlsTransport alerts", () => {
  test("stop() は ICE を止める前に暗号化した close_notify を送り、相手は closed になる", async () => {
    // Arrange
    const [session1, session2] = await dtlsTransportPair();
    const sent = recordSentDtlsAlerts(session1);
    const local = recordDtlsEvents(session1);
    const remote = recordDtlsEvents(session2);

    try {
      // Act: session1 を止める
      const stopping = session1.stop();

      // Assert: ローカルは同期で closed になり statechange は発火しない
      expect(session1.state).toBe("closed");
      await stopping;
      expect(local.states).toEqual([]);

      // Assert: epoch 1 の暗号化 alert が ICE の close より前に 1 回だけ送られる
      expect(sent.alerts).toHaveLength(1);
      expect(sent.alerts[0].epoch).toBe(1);
      expect(sent.alerts[0].fragment.length).toBeGreaterThan(2);
      expect(sent.order).toEqual(["alert", "ice-close"]);

      // Assert: 相手は statechange 付きで closed になり、error は発火しない
      await waitForDtlsState(session2, "closed");
      expect(remote.states).toEqual(["closed"]);
      expect(remote.errors).toEqual([]);
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("stop() の多重呼び出し・ICE 先行停止でも alert は高々 1 回で、有限時間で終わる", async () => {
    // Arrange
    const [session1, session2] = await dtlsTransportPair();
    const sent = recordSentDtlsAlerts(session1);
    await session1.iceTransport.stop();

    try {
      // Act: ICE が止まった後に stop() を並行して呼ぶ
      const started = Date.now();
      const first = session1.stop();
      const second = session1.stop();
      await Promise.all([first, second]);

      // Assert: 同じ Promise を共有し、送信経路がないので alert は送らず、すぐ終わる
      expect(first).toBe(second);
      expect(sent.alerts).toHaveLength(0);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(session1.state).toBe("closed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("handshake 中の stop() は平文の close_notify を送り、reject を残さずに終わる", async () => {
    // Arrange: 相手は handshake を始めない
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(session2.localParameters);
    session1.role = "client";
    const sent = recordSentDtlsAlerts(session1);
    const starting = session1.start().catch(() => undefined);
    await setTimeout(300);

    try {
      // Act: handshake 中に止める
      await session1.stop();

      // Assert: epoch 0 の平文 close_notify が送られ closed のまま
      expect(sent.alerts).toHaveLength(1);
      expect(sent.alerts[0].epoch).toBe(0);
      expect([...sent.alerts[0].fragment]).toEqual([
        AlertLevel.warning,
        AlertDesc.CloseNotify,
      ]);
      expect(session1.state).toBe("closed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
      void starting;
    }
  });

  test("handshake 中の stop() で start() が決着する（server / client 待機中）", async () => {
    for (const role of ["server", "client"] as const) {
      // Arrange: 相手は handshake を始めない
      const [session1, session2] = await createDtlsSessions();
      session1.setRemoteParams(session2.localParameters);
      session1.role = role;
      let settled = false;
      const starting = session1
        .start()
        .catch(() => undefined)
        .then(() => {
          settled = true;
        });
      // client は 100ms の待機中に止める場合も含める
      await setTimeout(role === "client" ? 20 : 300);

      try {
        // Act: handshake 中に止める
        await session1.stop();

        // Assert: start() は有限時間で決着し、closed のまま
        await Promise.race([starting, setTimeout(1000)]);
        expect(settled).toBe(true);
        expect(session1.state).toBe("closed");
      } finally {
        await Promise.allSettled([session1.stop(), session2.stop()]);
      }
    }
  });

  test("handshake 中に相手の close_notify を受けると start() が resolve し closed になる（failed / error にしない）", async () => {
    // Arrange: session2 は handshake を始めず、session1 は server として待つ
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(session2.localParameters);
    session1.role = "server";
    const local = recordDtlsEvents(session1);
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const starting = session1.start().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await setTimeout(300);

    try {
      // Act: 相手が close_notify を送る
      session2.setRemoteParams(session1.localParameters);
      session2.role = "client";
      const peer = session2.start().catch(() => undefined);
      await setTimeout(50);
      await session2.stop();
      await Promise.race([starting, setTimeout(2000)]);
      void peer;

      // Assert: start() は reject せずに resolve し、closed で終わる
      expect(outcome).toBe("resolved");
      expect(session1.state).toBe("closed");
      // Assert: close_notify は fatal alert ではないので、statechange は closed の 1 回だけで error は発火しない
      expect(local.states).toEqual(["connecting", "closed"]);
      expect(local.errors).toEqual([]);
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("fingerprint 不一致は handshake 中に bad_certificate を送り、検証側は fingerprint-failure、相手は dtls-failure になる", async () => {
    // Arrange
    const [session1, session2] = await createDtlsSessions();
    const expected = session2.localParameters.fingerprints[0];
    session1.setRemoteParams(
      new RTCDtlsParameters(
        [
          new RTCDtlsFingerprint(
            expected.algorithm,
            mutateFingerprint(expected.value),
          ),
        ],
        session2.localParameters.role,
      ),
    );
    session2.setRemoteParams(session1.localParameters);
    const local = recordDtlsEvents(session1);
    const remote = recordDtlsEvents(session2);

    try {
      // Act: 両側で handshake を始める
      const results = await Promise.allSettled([
        session1.start(),
        session2.start(),
      ]);

      // Assert: 両側の start() が reject し、検証側は不一致のエラーを返す
      expect(results[0].status).toBe("rejected");
      expect(String((results[0] as PromiseRejectedResult).reason)).toContain(
        "fingerprint mismatch",
      );
      expect(results[1].status).toBe("rejected");
      // Assert: 両側が failed になり、error が 1 回ずつ発火する
      expect(session1.state).toBe("failed");
      expect(session2.state).toBe("failed");
      expect(local.errors).toHaveLength(1);
      expect(remote.errors).toHaveLength(1);
      // Assert: 検証側は fingerprint-failure（alert 番号は dtls-failure 専用なので null）
      expect(local.errors[0].error.errorDetail).toBe("fingerprint-failure");
      expect(local.errors[0].error.sentAlert).toBeNull();
      expect(local.errors[0].error.receivedAlert).toBeNull();
      // Assert: 相手は bad_certificate を受信した dtls-failure
      expect(remote.errors[0].error.errorDetail).toBe("dtls-failure");
      expect(remote.errors[0].error.receivedAlert).toBe(
        AlertDesc.BadCertificate,
      );
      expect(remote.errors[0].error.sentAlert).toBeNull();
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("fingerprint 不一致以外の証明書検証失敗（対応アルゴリズムなし）は送信 alert 付きの dtls-failure になる", async () => {
    // Arrange: session1 は未対応アルゴリズムの fingerprint しか持たない
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(
      new RTCDtlsParameters(
        [new RTCDtlsFingerprint("md5", "00:11:22:33")],
        session2.localParameters.role,
      ),
    );
    session2.setRemoteParams(session1.localParameters);
    const local = recordDtlsEvents(session1);
    const remote = recordDtlsEvents(session2);

    try {
      // Act: 両側で handshake を始める
      const results = await Promise.allSettled([
        session1.start(),
        session2.start(),
      ]);

      // Assert: 両側の start() が reject し、両側が failed になる
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(session1.state).toBe("failed");
      expect(session2.state).toBe("failed");
      // Assert: 検証側は bad_certificate を送った dtls-failure（fingerprint-failure ではない）
      expect(local.errors).toHaveLength(1);
      expect(local.errors[0].error.errorDetail).toBe("dtls-failure");
      expect(local.errors[0].error.sentAlert).toBe(AlertDesc.BadCertificate);
      expect(local.errors[0].error.receivedAlert).toBeNull();
      // Assert: 相手は bad_certificate を受信した dtls-failure
      expect(remote.errors).toHaveLength(1);
      expect(remote.errors[0].error.errorDetail).toBe("dtls-failure");
      expect(remote.errors[0].error.receivedAlert).toBe(
        AlertDesc.BadCertificate,
      );
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("接続確立後に自分から fatal alert を送ると、送信側も sentAlert 付きの failed になる", async () => {
    // Arrange
    const [session1, session2] = await dtlsTransportPair();
    const local = recordDtlsEvents(session1);

    try {
      // Act: 接続済みの session1 から公開 API で fatal alert を送る
      await session1.dtls!.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);

      // Assert: 送信側は statechange 付きで failed になり、送信 alert 付きの dtls-failure が 1 回発火する
      expect(session1.state).toBe("failed");
      expect(local.states).toEqual(["failed"]);
      expect(local.errors).toHaveLength(1);
      expect(local.errors[0].error.errorDetail).toBe("dtls-failure");
      expect(local.errors[0].error.sentAlert).toBe(AlertDesc.InternalError);
      expect(local.errors[0].error.receivedAlert).toBeNull();
      // Assert: 相手も failed になる
      await waitForDtlsState(session2, "failed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test.each([
    ["close_notify", AlertLevel.warning, AlertDesc.CloseNotify, "closed"],
    ["fatal alert", AlertLevel.fatal, AlertDesc.InternalError, "failed"],
  ] as const)(
    "DTLS の onAlert リスナーが例外を投げても、受信した %s で終端状態（closed / failed）へ遷移する",
    async (_, level, description, expected) => {
      // Arrange: 受信側 DTLS socket に例外を投げる onAlert リスナーを付ける
      const [session1, session2] = await dtlsTransportPair();
      session2.dtls!.onAlert.subscribe(() => {
        throw new Error("listener failed");
      });

      try {
        // Act: session1 から alert を送る
        await session1.dtls!.sendAlert(level, description);

        // Assert: 受信側は終端状態へ遷移する
        await waitForDtlsState(session2, expected);
        expect(session2.state).toBe(expected);
      } finally {
        await Promise.allSettled([session1.stop(), session2.stop()]);
      }
    },
  );

  test("statechange リスナーが例外を投げても、handshake 中の close_notify で start() が決着する", async () => {
    // Arrange: session1 は server として待ち、statechange リスナーは closed で例外を投げる
    const [session1, session2] = await createDtlsSessions();
    session1.setRemoteParams(session2.localParameters);
    session1.role = "server";
    session1.onStateChange.subscribe((state) => {
      if (state === "closed") throw new Error("listener failed");
    });
    let outcome = "pending";
    const starting = session1.start().then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    await setTimeout(300);

    try {
      // Act: 相手が handshake を始めてすぐ止める（close_notify が届く）
      session2.setRemoteParams(session1.localParameters);
      session2.role = "client";
      const peer = session2.start().catch(() => undefined);
      await setTimeout(50);
      await session2.stop();
      await Promise.race([starting, setTimeout(2000)]);
      void peer;

      // Assert: start() は resolve し、closed で終わる
      expect(outcome).toBe("resolved");
      expect(session1.state).toBe("closed");
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });

  test("接続確立後に fatal alert を受けると failed になり、後から closed で上書きされない", async () => {
    // Arrange
    const [session1, session2] = await dtlsTransportPair();
    const remote = recordDtlsEvents(session2);
    const onerror = vi.fn();
    session2.onerror = onerror;

    try {
      // Act: session1 が fatal alert を送り、続けて close_notify も試みる
      await session1.dtls!.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);
      await session1.dtls!.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
      await waitForDtlsState(session2, "failed");
      await setTimeout(50);

      // Assert: failed への遷移と error イベントが 1 回だけ起きる
      expect(remote.states).toEqual(["failed"]);
      expect(remote.errors).toHaveLength(1);
      expect(remote.errors[0].error.receivedAlert).toBe(
        AlertDesc.InternalError,
      );
      expect(onerror).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([session1.stop(), session2.stop()]);
    }
  });
});

describe("RTCPeerConnection DTLS alerts", () => {
  test("pc.close() で相手の DTLS / SCTP / DataChannel が closed になる", async () => {
    // Arrange
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const dc1 = pc1.createDataChannel("alert");
    const remoteChannel = new Promise<any>((resolve) =>
      pc2.onDataChannel.subscribe(resolve),
    );
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription!);
    const dc2 = await remoteChannel;
    await waitUntil(() => dc1.readyState === "open", "dc1 did not open");
    const dtls2 = pc2.sctp!.transport;
    const dc2Closed = new Promise<void>((resolve) =>
      dc2.addEventListener("close", () => resolve()),
    );

    try {
      // Act: pc1 を閉じる
      const started = Date.now();
      await pc1.close();

      // Assert: close は短時間で終わり、pc2 の DTLS / SCTP / DataChannel が closed になる
      expect(Date.now() - started).toBeLessThan(2000);
      await waitForDtlsState(dtls2, "closed");
      await dc2Closed;
      expect(pc2.sctp!.state).toBe("closed");
      expect(dc2.readyState).toBe("closed");
      // Assert: 相手の close_notify では pc2 の connectionState は変わらない（connected のまま）
      expect(pc2.connectionState).toBe("connected");
      // Assert: pc1 は close() により closed
      expect(pc1.connectionState).toBe("closed");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });

  test("接続確立後に fatal alert を受けると DTLS / connectionState が failed、SCTP / DataChannel が closed になる", async () => {
    // Arrange
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const dc1 = pc1.createDataChannel("fatal");
    const remoteChannel = new Promise<any>((resolve) =>
      pc2.onDataChannel.subscribe(resolve),
    );
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription!);
    const dc2 = await remoteChannel;
    await waitUntil(() => dc1.readyState === "open", "dc1 did not open");
    await waitUntil(
      () => pc2.connectionState === "connected",
      `pc2 ${pc2.connectionState}`,
    );
    const dtls2 = pc2.sctp!.transport;
    const remote = recordDtlsEvents(dtls2);

    try {
      // Act: pc1 の DTLS から fatal alert を送る
      await pc1.sctp!.transport.dtls!.sendAlert(
        AlertLevel.fatal,
        AlertDesc.InternalError,
      );

      // Assert: pc2 の DTLS が failed になり、受信 alert 付きの dtls-failure が 1 回発火する
      await waitForDtlsState(dtls2, "failed");
      expect(remote.errors).toHaveLength(1);
      expect(remote.errors[0].error.errorDetail).toBe("dtls-failure");
      expect(remote.errors[0].error.receivedAlert).toBe(
        AlertDesc.InternalError,
      );
      // Assert: connectionState は failed、SCTP と DataChannel は closed になる
      await waitUntil(
        () => pc2.connectionState === "failed",
        `connectionState ${pc2.connectionState}`,
      );
      await waitUntil(
        () => dc2.readyState === "closed",
        `dc2 ${dc2.readyState}`,
      );
      expect(pc2.sctp!.state).toBe("closed");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });

  test("answer の fingerprint を改ざんすると両側の connectionState が failed になる", async () => {
    // Arrange
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.createDataChannel("tamper");

    try {
      // Act: offer / answer を交換し、pc1 へ渡す answer の fingerprint をゼロにする
      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription({
        type: "answer",
        sdp: zeroSdpFingerprints(pc2.localDescription!.sdp),
      });

      // Assert: 両側が failed になる
      await waitUntil(
        () =>
          pc1.connectionState === "failed" && pc2.connectionState === "failed",
        `connectionState ${pc1.connectionState} / ${pc2.connectionState}`,
      );
      expect(pc1.sctp!.transport.state).toBe("failed");
      expect(pc2.sctp!.transport.state).toBe("failed");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });
});

describe("接続開始中に DTLS が閉じた場合の connectionState", () => {
  test("start() が closed で戻っても PeerConnection は connected にならない", async () => {
    // Arrange: DTLS の start() が handshake 中に stop されて closed で戻る peer を作る
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.createDataChannel("x");
    pc1.onicecandidate = ({ candidate }) => {
      if (candidate) void pc2.addIceCandidate(candidate);
    };
    pc2.onicecandidate = ({ candidate }) => {
      if (candidate) void pc1.addIceCandidate(candidate);
    };
    const states: string[] = [];
    pc2.onconnectionstatechange = () => states.push(pc2.connectionState);
    try {
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const transport = pc2.dtlsTransports[0];
      const realStart = transport.start.bind(transport);
      transport.start = async () => {
        const starting = realStart();
        await setTimeout(10);
        await transport.stop();
        await starting;
      };

      // Act: answer を返して接続を始める
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      await setTimeout(1500);

      // Assert: closed な transport を connected と報告しない
      expect(transport.state).toBe("closed");
      expect(states).not.toContain("connected");
      expect(pc2.connectionState).not.toBe("connected");
      // connecting のまま残らず、終端状態（failed）に決着する
      expect(pc2.connectionState).not.toBe("connecting");
      expect(pc2.connectionState).toBe("failed");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });
});

describe("接続開始中に相手が close_notify で終了した場合", () => {
  test("PeerConnection の connectionState は connecting に残らず failed になる", async () => {
    // Arrange: pc1 の DTLS を handshake 中に stop する（close_notify が pc2 に届く）
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.createDataChannel("x");
    pc1.onicecandidate = ({ candidate }) => {
      if (candidate) void pc2.addIceCandidate(candidate);
    };
    pc2.onicecandidate = ({ candidate }) => {
      if (candidate) void pc1.addIceCandidate(candidate);
    };
    try {
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const transport1 = pc1.dtlsTransports[0];
      const realStart = transport1.start.bind(transport1);
      transport1.start = async () => {
        const starting = realStart();
        await setTimeout(10);
        await transport1.stop();
        await starting;
      };

      // Act: 接続を始める
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);
      await waitUntil(
        () => pc2.connectionState === "failed",
        `connectionState stays ${pc2.connectionState}`,
        4000,
      ).catch(() => undefined);

      // Assert: 終端状態（failed）になり connecting のまま残らない
      expect(pc2.connectionState).toBe("failed");
      // Assert: pc2 の DTLS は close_notify を受けた closed（fatal ではないので failed にしない）
      expect(pc2.dtlsTransports[0].state).toBe("closed");
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });
});
